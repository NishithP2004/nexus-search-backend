import {
    createClient
} from "redis";
import "dotenv/config"

const client = createClient({
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USERNAME,
    socket: {
        host: process.env.REDIS_HOST,
        port: 14490
    }
});

client.connect()
    .then(() => console.log("Connected to Redis successfully."))
    .catch(err => console.error)

export {
    client
}