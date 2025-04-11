import { Ollama } from 'ollama';
import "dotenv/config"

const models = ["gemma3:4b"] 

const ollama = new Ollama({
    host: process.env.OLLAMA_HOST || "http://localhost:11434"
})

async function loadModel(model) {
    return ollama.pull({
        model
    })
}

async function loadModels(models) {
    console.log("Loading Models. Please Wait...")
    for(let model of models) {
        await loadModel(model);
        console.log(`Loaded: ${model}`)
    }
    console.log("Models Loaded.")
}

await loadModels(models)

const generate_response = async (parameters) => {
    try {
        const {
            prompt,
            model,
            system,
            temperature,
            format
        } = parameters

        let response = (await ollama.generate({
            model,
            system,
            prompt,
            temperature,
            format
        })).response

        return response;
    } catch (err) {
        console.error(`Error generating AI response: ${err.message}`)
        throw err;
    }
}

const generate_embeddings = async (parameters) => {
    try {
        const {
            input,
            model
        } = parameters

        let embedding = (await ollama.embed({
            input,
            model
        })).embeddings[0]

        return embedding;
    } catch (err) {
        console.error(`Error generating embeddings: ${err.message}`)
        throw err;
    }
}

export { generate_response, generate_embeddings, models }