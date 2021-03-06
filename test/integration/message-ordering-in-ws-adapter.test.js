const { startTracker, startNetworkNode, startStorageNode, Protocol } = require('streamr-network')
const intoStream = require('into-stream')
const { wait, waitForCondition } = require('streamr-test-utils')

const { startBroker, createClient } = require('../utils')

const { StreamMessage, MessageID, MessageRef } = Protocol.MessageLayer

const trackerPort = 11400
const networkPort1 = 11402
const networkPort2 = 11403
const networkPort3 = 11404
const wsPort = 11401

function createStreamMessage(streamId, idx, prevIdx) {
    return new StreamMessage({
        messageId: new MessageID(streamId, 0, idx, 0, 'publisherId', 'msgChainId'),
        prevMsgRef: prevIdx != null ? new MessageRef(prevIdx, 0) : null,
        content: {
            key: idx,
        },
    })
}

describe('message ordering and gap filling in websocket adapter', () => {
    let tracker
    let publisherNode
    let nodeWithMissingMessages
    let broker
    let subscriber
    let freshStream
    let freshStreamId

    beforeEach(async () => {
        tracker = await startTracker({
            host: '127.0.0.1',
            port: trackerPort,
            id: 'tracker'
        })
        publisherNode = await startNetworkNode({
            host: '127.0.0.1',
            port: networkPort1,
            id: 'publisherNode',
            trackers: [tracker.getAddress()]
        })
        publisherNode.start()
        broker = await startBroker({
            name: 'broker1',
            privateKey: '0x14a779a0147670070a71e539ae830c162abd8b3b74f807880b05d2cd80a9c729',
            networkPort: networkPort2,
            trackerPort,
            wsPort
        })

        subscriber = createClient(wsPort, {
            auth: {
                apiKey: 'tester1-api-key'
            },
            orderMessages: false,
        })
        await subscriber.ensureConnected()

        freshStream = await subscriber.createStream({
            name: 'message-ordering-in-ws-adapter.test.js-' + Date.now()
        })
        freshStreamId = freshStream.id
    })

    afterEach(async () => {
        await subscriber.ensureDisconnected()

        await publisherNode.stop()

        if (nodeWithMissingMessages) {
            await nodeWithMissingMessages.stop()
        }

        await broker.close()
        await tracker.stop()
    })

    it('messages received out-of-order are ordered by ws adapter', async () => {
        const receivedMessages = []

        subscriber.subscribe({
            stream: freshStreamId
        }, (message, metadata) => {
            receivedMessages.push(message)
        })

        publisherNode.publish(createStreamMessage(freshStreamId, 100, null))
        publisherNode.publish(createStreamMessage(freshStreamId, 500, 400))
        await wait(250)
        publisherNode.publish(createStreamMessage(freshStreamId, 600, 500))
        publisherNode.publish(createStreamMessage(freshStreamId, 200, 100))
        publisherNode.publish(createStreamMessage(freshStreamId, 300, 200))
        await wait(500)
        publisherNode.publish(createStreamMessage(freshStreamId, 400, 300))

        await waitForCondition(() => receivedMessages.length >= 6)

        expect(receivedMessages).toEqual([
            {
                key: 100
            },
            {
                key: 200
            },
            {
                key: 300
            },
            {
                key: 400
            },
            {
                key: 500
            },
            {
                key: 600
            },
        ])
    })

    it('missing messages are gap filled by ws adapter', async () => {
        // Set up new network node that has missing messages in its storage
        const resendRequests = []
        nodeWithMissingMessages = await startStorageNode({
            host: '127.0.0.1',
            port: networkPort3,
            id: 'missingMessagesNode',
            trackers: [tracker.getAddress()],
            storages: [{
                store() {},
                requestRange(...args) {
                    resendRequests.push(args)
                    return intoStream.object([
                        createStreamMessage(freshStreamId, 200, 100),
                        createStreamMessage(freshStreamId, 300, 200)
                    ])
                }
            }]
        })
        nodeWithMissingMessages.subscribe(freshStreamId, 0)
        nodeWithMissingMessages.start()

        const receivedMessages = []
        subscriber.subscribe({
            stream: freshStreamId
        }, (message, metadata) => {
            receivedMessages.push(message)
        })

        publisherNode.publish(createStreamMessage(freshStreamId, 100, null))
        publisherNode.publish(createStreamMessage(freshStreamId, 500, 400))
        publisherNode.publish(createStreamMessage(freshStreamId, 400, 300))
        publisherNode.publish(createStreamMessage(freshStreamId, 600, 500))

        await waitForCondition(() => receivedMessages.length >= 6, 15 * 1000)

        expect(receivedMessages).toEqual([
            {
                key: 100
            },
            {
                key: 200
            },
            {
                key: 300
            },
            {
                key: 400
            },
            {
                key: 500
            },
            {
                key: 600
            },
        ])
        expect(resendRequests).toEqual([[freshStreamId, 0, 100, 1, 300, 0, 'publisherId', 'msgChainId']])
    }, 20 * 1000)
})
