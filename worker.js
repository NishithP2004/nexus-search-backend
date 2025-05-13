import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "worker_threads";
import { visitPage } from "./utils.js";
import "dotenv/config"

if (!isMainThread) {
  (async function() {
    const { linksToVisit } = workerData;

    for (let link of linksToVisit) {
      try {
        let response = await visitPage(link);
        parentPort.postMessage({
          success: true,
          ...response,
        });
      } catch (err) {
        console.error(err.message);
        continue;
      }
    }
  })();
}
