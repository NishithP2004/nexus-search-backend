const {
    Worker,
    isMainThread,
    parentPort,
    workerData
} = require("worker_threads");
const {
    visitPage
} = require("./utils");
require("dotenv").config();

if (!isMainThread) {
    (async function crawl() {
        const {
            linksToVisit
        } = workerData;

        for (let link of linksToVisit) {
            try {
                let response = await visitPage(link);
                parentPort.postMessage({
                    success: true,
                    ...response
                })
            } catch (err) {
                console.error(err);
                continue;
            }
        }
    })();
}