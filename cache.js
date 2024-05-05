const { createClient } = require("redis");
require('dotenv').config();

const client = createClient({
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USERNAME,
    socket: {
        host: process.env.REDIS_HOST,
        port: 14490
    }
});

(async function() {
    await client.connect();
})();

module.exports = {
    client
}