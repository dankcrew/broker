const assert = require('assert')
const sinon = require('sinon')
const redis = require('redis')

const RedisOffsetFetcher = require('../lib/redis-offset-fetcher')

describe('RedisOffsetFetcher', function() {

	const REDIS_HOST = "127.0.0.1"

	var testRedisClient
	var redisOffsetFetcher

	beforeEach(function() {
		testRedisClient = redis.createClient({ host: REDIS_HOST})
		redisOffsetFetcher = new RedisOffsetFetcher(REDIS_HOST, "")
	})

	afterEach(function() {
		testRedisClient.del("stream-1-0")
		testRedisClient.quit()
	})

	describe('fetchOffset', function() {
		it("returns null if key doesn't exist", function() {
			return redisOffsetFetcher.fetchOffset("stream-1", 0).then(function(value) {
				assert.equal(value, null)
			})
		})

		it("returns value if key exists", function(done) {
			testRedisClient.setex("stream-1-0", 15, "2487679201527", function(err, res) {
				if (err) {
					done(err)
				}
				return redisOffsetFetcher.fetchOffset("stream-1", 0).then(function(value) {
					assert.equal(value, 2487679201527)
					done()
				})
			})
		})
	})
})