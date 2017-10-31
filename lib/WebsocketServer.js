'use strict';

var events = require('events')
var debug = require('debug')('WebsocketServer')
var debugProtocol = require('debug')('WebsocketServer:protocol')
var constants = require('./constants')
var Stream = require('./stream')
var Connection = require('./connection')
var uuid = require('node-uuid')
var WebSocketServer = require('uws').Server

var DEFAULT_PARTITION = 0

function WebsocketServer(http, realtimeAdapter, historicalAdapter, latestOffsetFetcher, wss, streamFetcher) {
	var _this = this

	this.realtimeAdapter = realtimeAdapter
	this.historicalAdapter = historicalAdapter
	this.latestOffsetFetcher = latestOffsetFetcher
	this.streamFetcher = streamFetcher
	this.msgCounter = 0
	this.connectionCounter = 0

	// This handler is for realtime messages, not resends
	this.realtimeAdapter.on('message', function(messageAsArray, streamId, streamPartition) {
		_this.broadcastMessage(messageAsArray, streamId, streamPartition)
	})

	this.wss = wss || new WebSocketServer({
			server: http,
			path: '/api/v1/ws'
    })

	var requestHandlersByType = {
		subscribe: _this.handleSubscribeRequest,
		unsubscribe: _this.handleUnsubscribeRequest,
		resend: _this.handleResendRequest
	}

	this.wss.on('connection', function connection(socket) {
		if (socket.id !== undefined) {
			throw "Whoa, socket.id is already defined"
		} else {
			socket.id = uuid.v4()
		}

		debug("connection established: %o", socket)
		_this.connectionCounter++

		var connection = new Connection(socket)

		socket.on('message', function(data) {
			try {
				var request = JSON.parse(data)
				var handler = requestHandlersByType[request.type]
				if (!handler) {
					throw "Unknown request type: "+request.type
				} else {
					debugProtocol("%s: %s: %o", request.type, connection.id, request)
					handler.call(_this, connection, request)
				}
			} catch(err) {
				console.log("Error handling message: ", data)
				console.log(err)
				connection.sendError({error: err})
			}
		})

		socket.on('close', function(code, message) {
			_this.connectionCounter--
			_this.handleDisconnect(connection)
		})
	});

	this.streams = {}

	setInterval(function() {
		console.log("Connections: %d, Messages / min: %d (%d / sec)", _this.connectionCounter, _this.msgCounter, _this.msgCounter / 60)
		_this.msgCounter = 0
	}, 60*1000)
}

WebsocketServer.prototype.__proto__ = events.EventEmitter.prototype;

WebsocketServer.prototype.handleResendRequest = function(connection, req) {
	var _this = this

	const streamId = req.stream
	const streamPartition = req.partition || DEFAULT_PARTITION
	const authkey = req.authKey

	const requestRef = {stream: streamId, partition: streamPartition, sub: req.sub}

	function sendMessage(message) {
		// "broadcast" to the socket of this connection (ie. this single client) and specific subscription id
		_this.msgCounter++
		connection.sendUnicast(message, req.sub)
	}
	function sendResending() {
		debugProtocol('resending: %s: %o', connection.id, requestRef)
		connection.sendResending(requestRef)
	}
	function sendResent() {
		debugProtocol('resent: %s: %o', connection.id, requestRef)
		connection.sendResent(requestRef)
	}
	function sendNoResend() {
		debugProtocol('no_resend: %s: %o', connection.id, requestRef)
		connection.sendNoResend(requestRef)
	}

	var nothingToResend = true
	function msgHandler(msg) {
		if (nothingToResend) {
			nothingToResend = false
			sendResending()
		}
		sendMessage(msg.toArray())
	}
	function doneHandler() {
		if (nothingToResend) {
			sendNoResend()
		} else {
			sendResent()
		}
	}

	Promise.all([
		this.streamFetcher.authenticate(streamId, authkey),
		this.latestOffsetFetcher.fetchOffset(streamId, streamPartition)
	]).then(function(results) {
		const latestKnownOffset = results[1]

		// Resend all
		if (req.resend_all===true) {
			_this.historicalAdapter.getAll(streamId, streamPartition, msgHandler, doneHandler, latestKnownOffset)
		}
		// Resend range
		else if (req.resend_from != null && req.resend_to != null) {
			_this.historicalAdapter.getOffsetRange(streamId, streamPartition, req.resend_from, req.resend_to, msgHandler, doneHandler, latestKnownOffset)
		}
		// Resend from a given offset
		else if (req.resend_from != null) {
			_this.historicalAdapter.getFromOffset(streamId, streamPartition, req.resend_from, msgHandler, doneHandler, latestKnownOffset)
		}
		// Resend the last N messages
		else if (req.resend_last != null) {
			_this.historicalAdapter.getLast(streamId, streamPartition, req.resend_last, msgHandler, doneHandler, latestKnownOffset)
		}
		// Resend from a given time
		else if (req.resend_from_time != null) {
			_this.historicalAdapter.getFromTimestamp(streamId, streamPartition, req.resend_from_time, msgHandler, doneHandler)
		}
		else {
			debug("handleResendRequest: unknown resend request: %o", req)
			sendNoResend()
		}
	}).catch(function(err) {
		if (typeof err === "number") {
			connection.sendError('Not authorized to request resend from stream ' + streamId + " and partition " + streamPartition)
		}
	})
}

/**
 * Creates and returns a Stream object, holding the Stream subscription state.
 * 
 * In normal conditions, the Stream object is cleaned when no more
 * clients are subscribed to it.
 *
 * However, ill-behaving clients could just ask for resends on a Stream
 * and never subscribe to it, which would lead to leaking memory.
 * To prevent this, clean up the Stream object if it doesn't
 * end up in subscribed state within one minute (for example, ill-behaving)
 * clients only asking for resends and never subscribing.
 **/
WebsocketServer.prototype.createStreamObject = function(streamId, streamPartition) {
	if (streamId == null || streamPartition == null) {
		throw "streamId or streamPartition not given!"
	}

	var _this = this
	var stream = new Stream(streamId, streamPartition, 'init')
	this.streams[this.getStreamLookupKey(streamId, streamPartition)] = stream
	
	stream.stateTimeout = setTimeout(function() {
		if (stream.state !== 'subscribed') {
			debug("Stream %s never got to subscribed state, cleaning..", streamId)
			_this.deleteStreamObject(streamId)
		}
	}, 60*1000)

	this.emit('stream-object-created', stream)
	debug("Stream object created: %o", stream)

	return stream
}

WebsocketServer.prototype.getStreamLookupKey = function(streamId, streamPartition) {
	return streamId+'-'+streamPartition
}

WebsocketServer.prototype.getStreamObject = function(streamId, streamPartition) {
	return this.streams[this.getStreamLookupKey(streamId, streamPartition)]
}

WebsocketServer.prototype.deleteStreamObject = function(streamId, streamPartition) {
	if (streamId == null || streamPartition == null) {
		throw "streamId or streamPartition not given!"
	}

	var stream = this.getStreamObject(streamId, streamPartition)
	debug("Stream object deleted: %o", stream)
	if (stream) {
		clearTimeout(stream.stateTimeout)
		delete this.streams[this.getStreamLookupKey(streamId, streamPartition)]
		this.emit('stream-object-deleted', stream)
	}
}

WebsocketServer.prototype.broadcastMessage = function(message, streamId, streamPartition) {
	const stream = this.getStreamObject(streamId, streamPartition)
	if (stream) {
		const connections = stream.getConnections()

		connections.forEach(function(connection) {
			connection.sendBroadcast(message)
		})

		this.msgCounter += connections.length
	}
}

WebsocketServer.prototype.handleSubscribeRequest = function(connection, request) {
	var _this = this

	// Check that the request is valid
	if (!request.stream) {
		var response = {
			error: "Error: stream id not defined. Are you using an outdated client?"
		}
		debugProtocol('subscribed (error): %s: %o', connection.id, response)
		connection.sendError(response)
	} else {
		var streamId = request.stream
		var streamPartition = request.partition || DEFAULT_PARTITION
		var authKey = request.authKey
		var requestRef = {stream: streamId, partition: streamPartition}

		this.streamFetcher.authenticate(streamId, authKey).then(function(streamJson) {
				var stream = _this.getStreamObject(streamId, streamPartition)

				// Create Stream if it does not exist
				if (!stream) {
					stream = _this.createStreamObject(streamId, streamPartition)
				}

				// Subscribe now if the stream is not already subscribed or subscribing
				if (!(stream.state==='subscribed' || stream.state==='subscribing')) {
					stream.state = 'subscribing'
					_this.realtimeAdapter.subscribe(streamId, streamPartition, function(err) {
						if (err) {
							stream.emit('subscribed', err)

							// Delete the stream ref on subscribe error
							_this.deleteStreamObject(stream.id)

							console.log("Error subscribing to "+stream.id+": "+err)
						}
						else {
							stream.state = 'subscribed'
							stream.emit('subscribed')
						}
					})
				}

				var onSubscribe = function() {
					// Join the room
					stream.addConnection(connection)
					connection.addStream(stream)

					debug("Socket %s is now subscribed to streams: %o", connection.id, connection.getStreams())
					debugProtocol('subscribed: %s: %o', connection.id, requestRef)

					connection.sendSubscribed(requestRef)
				}

		var onError = function(err) {
			connection.sendSubscribed({
				stream: streamId,
				partition: streamPartition,
				error: err
			})
		}

				// If the Stream is subscribed, we're good to go
				if (stream.state === 'subscribed') {
					onSubscribe()
				}
				// If the Stream is not yet subscribed, wait for the event
				if (stream.state !== 'subscribed') {
					stream.once('subscribed', function(err) {
						if (err)
							onError(err)
						else
							onSubscribe()
					})
				}
			}).catch(function() {
				debugProtocol('subscribed (error): %s: %o', connection.id, response)
				connection.sendError('Not authorized to subscribe to stream ' + streamId + " and partition " + streamPartition)
			})
	}
}

WebsocketServer.prototype.handleUnsubscribeRequest = function(connection, request, noAck) {
	var _this = this

	var streamId = request.stream
	var streamPartition = request.partition || DEFAULT_PARTITION
	var stream = this.getStreamObject(streamId, streamPartition)

	if (stream) {
		debug("handleUnsubscribeRequest: socket %s unsubscribed from stream %s partition %d", connection.id, streamId, streamPartition)

		stream.removeConnection(connection)
		connection.removeStream(streamId, streamPartition)

		debug("handleUnsubscribeRequest: Socket %s is now subscribed to streams: %o", connection.id, connection.getStreams())

		/**
		 * Check whether anyone is subscribed to the stream anymore
		 */
		if (stream.getConnections().length) {
			debug("checkRoomEmpty: Clients remaining on %s partition %d: %d", streamId, streamPartition, stream.getConnections().length)
		}
		else {
			debug("checkRoomEmpty: stream %s partition %d has no clients remaining, unsubscribing realtimeAdapter...", streamId, streamPartition)
			this.realtimeAdapter.unsubscribe(streamId, streamPartition)
			this.deleteStreamObject(streamId, streamPartition)
		}

		if (!noAck) {
			connection.sendUnsubscribed({stream: streamId, partition: streamPartition})
		}
	} else {
		connection.sendError({error: "Not subscribed", request: request})
	}
}

WebsocketServer.prototype.handleDisconnect = function(connection) {
	var _this = this
	debug("handleDisconnect: socket %s was on streams: %o", connection.id, connection.getStreams())

	var unsub = connection.getStreams()
	
	// Unsubscribe from all streams
	unsub.forEach(function(stream) {
		_this.handleUnsubscribeRequest(connection, {stream: stream.id, partition: stream.partition}, true)
	})
}

module.exports = WebsocketServer