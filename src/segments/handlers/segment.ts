import { ALBEvent, ALBResult } from 'aws-lambda';
import { ServiceError } from '../../shared/types';
import delaySCC from '../../manifests/utils/corruptions/delay';
import statusCodeSCC from '../../manifests/utils/corruptions/statusCode';
import timeoutSCC from '../../manifests/utils/corruptions/timeout';
import throttleSCC from '../../manifests/utils/corruptions/throttle';
import { corruptorConfigUtils } from '../../manifests/utils/configs';
import {
  generateErrorResponse,
  getState,
  isValidUrl,
  putState,
  refineALBEventQuery
} from '../../shared/utils';
import { THROTTLING_PROXY } from '../constants';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function segmentHandler(
  event: ALBEvent,
  reqSegmentIndexInt?: number,
  manifestStateName?: string
): Promise<ALBResult> {
  // To be able to reuse the handlers for AWS lambda function - input should be ALBEvent
  const query = refineALBEventQuery(event.queryStringParameters);

  if (!query.url || !isValidUrl(query.url)) {
    const errorRes: ServiceError = {
      status: 400,
      message: "Missing a valid 'url' query parameter"
    };
    return generateErrorResponse(errorRes);
  }
  try {
    const configUtils = corruptorConfigUtils(new URLSearchParams(query));
    configUtils
      .register(delaySCC)
      .register(statusCodeSCC)
      .register(timeoutSCC)
      .register(throttleSCC);

    const [error, allSegmentCorr] = configUtils.getAllSegmentConfigs();
    if (error) {
      return generateErrorResponse(error);
    }
    // apply Timeout
    if (allSegmentCorr.get('timeout')) {
      console.log(`Timing out ${query.url}`);
      return;
    }
    // apply Delay
    if (allSegmentCorr.get('delay')) {
      const delay = Number(allSegmentCorr.get('delay').fields?.ms);
      console.log(`Applying ${delay}ms delay to ${query.url}`);
      await sleep(delay);
    }
    // apply Status Code
    if (
      allSegmentCorr.get('statusCode') &&
      allSegmentCorr.get('statusCode').fields.code !== 'undefined'
    ) {
      const state = getState(manifestStateName);
      const retryCounts = state.retryCounts;

      // Always increase the count
      const retryCount = retryCounts.get(reqSegmentIndexInt) ?? 0;
      retryCounts.set(reqSegmentIndexInt, retryCount + 1);
      putState(manifestStateName, { ...state, retryCounts });

      const numberOfTimesToError = <number>(
        allSegmentCorr.get('statusCode').fields.errorCount
      );

      // Error every time if no numberOfTimesToError are set, or error numberOfTimesToError times
      if (!numberOfTimesToError || retryCount < numberOfTimesToError) {
        console.log(
          `Retry count ${retryCount} for segment ${reqSegmentIndexInt}`,
          reqSegmentIndexInt
        );
        const code = <number>allSegmentCorr.get('statusCode').fields.code;
        console.log(`Applying corruption with status ${code} to ${query.url}`);
        return {
          statusCode: code,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Origin'
          },
          body: JSON.stringify({
            message: '[Stream Corruptor]: Applied Status Code Corruption'
          })
        };
      }
    }
    // apply Throttle
    if (
      allSegmentCorr.get('throttle') &&
      allSegmentCorr.get('throttle').fields.rate !== 'undefined'
    ) {
      const rate = Number(allSegmentCorr.get('throttle').fields.rate);
      return {
        statusCode: 302,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Origin',
          Location:
            '/api/v2' + THROTTLING_PROXY + '?url=' + query.url + '&rate=' + rate
        },
        body: 'stream corruptor throttling redirect'
      };
    }
    // Redirect to Source File
    return {
      statusCode: 302,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Origin',
        Location: query.url
      },
      body: 'stream corruptor redirect'
    };
  } catch (err) {
    const errorRes: ServiceError = {
      status: 500,
      message: err.message ? err.message : err
    };
    return generateErrorResponse(errorRes);
  }
}
