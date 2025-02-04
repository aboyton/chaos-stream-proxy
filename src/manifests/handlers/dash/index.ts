import { ALBEvent, ALBResult } from 'aws-lambda';
import fetch from 'node-fetch';
import {
  STATEFUL,
  generateErrorResponse,
  isValidUrl,
  newState
} from '../../../shared/utils';
import dashManifestUtils from '../../utils/dashManifestUtils';

export default async function dashHandler(event: ALBEvent): Promise<ALBResult> {
  /**
   * #1 - const originalUrl = req.body.query("url");
   * #2 - const originalManifest = await fetch(originalUrl);
   * #3 - create proxy manifest and return response from it
   */
  const { url } = event.queryStringParameters;

  if (!url || !isValidUrl(url)) {
    return generateErrorResponse({
      status: 400,
      message: "Missing a valid 'url' query parameter"
    });
  }

  try {
    const dashManifestResponse = await fetch(url);
    if (!dashManifestResponse.ok) {
      return generateErrorResponse({
        status: dashManifestResponse.status,
        message: 'Unsuccessful Source Manifest fetch'
      });
    }

    const stateKey = STATEFUL
      ? newState({ retryCounts: new Map() })
      : undefined;

    const reqQueryParams = new URLSearchParams(event.queryStringParameters);
    const text = await dashManifestResponse.text();
    const dashUtils = dashManifestUtils();
    const proxyManifest = dashUtils.createProxyDASHManifest(
      text,
      reqQueryParams,
      stateKey
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/dash+xml',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Origin'
      },
      body: proxyManifest
    };
  } catch (err) {
    // for unexpected errors
    return generateErrorResponse({
      status: 500,
      message: err.message || err
    });
  }
}
