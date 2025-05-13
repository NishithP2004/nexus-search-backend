import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "worker_threads";
import {
  visitPage
} from "./utils.js";
import "dotenv/config"

if (!isMainThread) {
  async function crawl() {
    const {
      linksToVisit
    } = workerData;

    for (let link of linksToVisit) {
      try {
        console.log("Crawling:", link)
        let response = await visitPage(link);
        parentPort.postMessage({
          success: true,
          ...response,
        });
      } catch (err) {
        console.error(err.message);
        parentPort.postMessage({
          success: false,
          url: link,
          error: err.message,
        });
        continue;
      }
    }
  }

  await crawl()
  process.exit(0) // Explit exit after task completion
}