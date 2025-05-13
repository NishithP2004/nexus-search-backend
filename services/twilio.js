import "dotenv/config"
import morgan from "morgan"
import twilio from "twilio"
import express from "express"

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express.Router();

app.use(express.json())
app.use(express.urlencoded({
    extended: true
}))
app.use(morgan(":method :url :status - :remote-addr"));

let details = await client.balance.fetch();
console.log("Account sid: %s\nBalance: %f %s", details.accountSid, details.balance, details.currency)

app.post("/call", async (req, res) => {
    try {
        const ph = req.body.ph;
        const call = await client.calls.create({
            to: ph,
            from: process.env.TWILIO_PHONE_NUMBER,
            sendDigits: "w",
            url: `${process.env.HOST_URL}/twilio/greeting`,
            statusCallback: `${process.env.HOST_URL}/twilio/status`,
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["initiated", "answered", "completed"]
        })

        console.log("Call Initiated: %s", call.sid);

        res.status(201).send({
            success: true,
            sid: call.sid
        })
    } catch (err) {
        res.status(500).send({
            error: err.message,
            success: false
        })
    }
})

app.post("/greeting", (req, res) => {
    console.log(req.body)
    const twiml = new VoiceResponse();

    twiml
        .gather({
            action: "/twilio/init",
            input: "dtmf",
            method: "POST",
            numDigits: 1
        })
        .say({
            voice: "alice"
        }, "Welcome to Nexus - Search on Call experience ! Please press 1 to get started..")

    res.type("text/xml")

    res.send(twiml.toString());
})

app.get("/bgm.mp3", (req, res) => {
    res.sendFile(__dirname + "/bgm.mp3")
})

export default app;