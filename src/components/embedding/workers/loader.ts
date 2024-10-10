/* eslint-disable max-len */
import type {
  PromptPoint,
  UMAPPointStreamData,
  LoaderWorkerMessage
} from '../../../types/embedding-types';
import {
  splitStreamTransform,
  parseJSONTransform,
  timeit
} from '../../../utils/utils';
import { config } from '../../../config/config';

const DEBUG = config.debug;
const BASE_POINT_THRESHOLD = 5000; // Base threshold
let POINT_THRESHOLD = BASE_POINT_THRESHOLD; // Dynamic threshold

let pendingDataPoints: PromptPoint[] = [];
let loadedPointCount = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let sentPointCount = 0;
let lastDrawnPoints: PromptPoint[] | null = null;
let isSending = false;

/**
 * Handle message events from the main thread
 * @param e Message event
 */
self.onmessage = (e: MessageEvent<LoaderWorkerMessage>) => {
  switch (e.data.command) {
    case 'startLoadData': {
      console.log('Worker: start streaming data');
      timeit('Stream data', true);
      const url = e.data.payload.url;
      startLoadData(url);
      break;
    }
    default: {
      console.error('Worker: unknown message', e.data.command);
      break;
    }
  }
};

/**
 // eslint-disable-next-line max-len, max-len
 * Start loading the large UMAP data with improved error handling, redirect support, and timeout
 * @param url URL to the NDJSON file
 */
const startLoadData = (url: string) => {
  fetchWithTimeout(url, 30000, { redirect: 'follow', mode: 'cors' })
    .then(async response => {
      if (!response.ok) {
        console.error('Failed to load data', response);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const reader = response.body
        ?.pipeThrough(new TextDecoderStream())
        ?.pipeThrough(splitStreamTransform('\n'))
        ?.pipeThrough(parseJSONTransform())
        ?.getReader();

      while (true && reader !== undefined) {
        const result = await reader.read();
        if (result.done) {
          timeit('Stream data', DEBUG);
          pointStreamFinished();
          break;
        }
        processPointStream(result.value as UMAPPointStreamData);

        // Throttle data sending with requestAnimationFrame
        if (pendingDataPoints.length > POINT_THRESHOLD && !isSending) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
          await sendDataBatch(false);
        }
      }
    })
    .catch((error) => {
      console.error("Fetch or stream error:", error);
    });
};

/**
 * Process one data point
 * @param point Loaded data point
 */
const processPointStream = (point: UMAPPointStreamData) => {
  const promptPoint: PromptPoint = {
    x: point[0],
    y: point[1],
    prompt: point[2],
    id: loadedPointCount
  };

  if (point.length > 3) promptPoint.time = point[3];
  if (point.length > 4) promptPoint.groupID = point[4];

  pendingDataPoints.push(promptPoint);
  loadedPointCount += 1;

  // Increase threshold dynamically if previous batch was sent quickly
  if (loadedPointCount % (BASE_POINT_THRESHOLD * 5) === 0) {
    POINT_THRESHOLD = Math.min(POINT_THRESHOLD + BASE_POINT_THRESHOLD, 20000);
  }
};

/**
 * Send a batch of data to the main thread
 * @param isLastBatch Whether this is the last batch
 */
const sendDataBatch = async (isLastBatch) => {
  isSending = true;

  const result: LoaderWorkerMessage = {
    command: 'transferLoadData',
    payload: {
      isFirstBatch: lastDrawnPoints === null,
      isLastBatch: isLastBatch,
      points: pendingDataPoints,
      loadedPointCount
    }
  };
  postMessage(result);

  sentPointCount += pendingDataPoints.length;
  lastDrawnPoints = pendingDataPoints.slice();
  pendingDataPoints = [];

  isSending = false;
};

/**
 * Notify the main thread when finished streaming all data
 */
const pointStreamFinished = async () => {
  await sendDataBatch(true);
};

/**
 * Fetch with timeout to handle potential network stalls
 * @param url URL to fetch
 * @param timeout Timeout duration in milliseconds
 * @param options Fetch options
 */
const fetchWithTimeout = (url, timeout = 30000, options = {}) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fetch timed out')), timeout);
    fetch(url, options)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};
