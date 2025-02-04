import { Manifest } from '../../shared/types';
import * as xml2js from 'xml2js';
import { IndexedCorruptorConfigMap, CorruptorConfigMap } from './configs';
import { proxyPathBuilder } from '../../shared/utils';
import { URLSearchParams } from 'url';

interface DASHManifestUtils {
  mergeMap: (
    segmentListSize: number,
    configsMap: IndexedCorruptorConfigMap
  ) => CorruptorConfigMap;
}

export interface DASHManifestTools {
  createProxyDASHManifest: (
    dashManifestText: string,
    originalUrlQuery: URLSearchParams,
    stateKey?: string | undefined
  ) => Manifest; // look def again
  utils: DASHManifestUtils;
}

export default function (): DASHManifestTools {
  const utils = {
    mergeMap(
      targetSegmentIndex: number,
      configsMap: IndexedCorruptorConfigMap
    ): CorruptorConfigMap {
      const outputMap = new Map();
      const d = configsMap.get('*');
      if (d) {
        for (const name of d.keys()) {
          const { fields } = d.get(name);
          outputMap.set(name, { fields: { ...fields } });
        }
      }
      // Populate any explicitly defined corruptions into the list
      const configCorruptions = configsMap.get(targetSegmentIndex);
      if (configCorruptions) {
        // Map values always take precedence
        for (const name of configCorruptions.keys()) {
          // If fields isn't set, it means it's a skip if *, otherwise no-op
          if (!configCorruptions.get(name).fields) {
            outputMap.delete(name);
            continue;
          }
          outputMap.set(name, configCorruptions.get(name));
        }
      }
      return outputMap;
    }
  };
  return {
    utils,
    createProxyDASHManifest(
      dashManifestText: string,
      originalUrlQuery: URLSearchParams,
      stateKey?: string | undefined
    ): string {
      const parser = new xml2js.Parser();
      const builder = new xml2js.Builder();

      let DASH_JSON;
      parser.parseString(dashManifestText, function (err, result) {
        DASH_JSON = result;
      });

      let globalBaseUrl;
      if (DASH_JSON.MPD.BaseURL) {
        // There should only ever be one baseurl according to schema
        globalBaseUrl = DASH_JSON.MPD.BaseURL[0];
      }
      // Remove base url from manifest since we are using relative paths for proxy
      delete DASH_JSON.MPD.BaseURL;

      let staticQueryUrl: URLSearchParams;

      DASH_JSON.MPD.Period.map((period) => {
        let baseUrl = globalBaseUrl;
        if (period.BaseURL?.[0]) {
          baseUrl = period.BaseURL[0];
          // Remove base url from manifest since we are using relative paths for proxy
          delete period.BaseURL;
        }
        period.AdaptationSet.map((adaptationSet) => {
          // If there is a SegmentTemplate directly in the adaptationSet there should only be one
          // But if it has no media property it is invalid and we should try the Representation instead
          if (adaptationSet.SegmentTemplate?.[0]?.$?.media) {
            const segmentTemplate = adaptationSet.SegmentTemplate[0];

            // Media attr
            const mediaUrl = segmentTemplate.$.media;
            const hasTime = mediaUrl.toString().includes('$Time$');
            // Convert relative segment offsets to absolute ones
            // Also clones params to avoid mutating input argument
            const [urlQuery, changed] = convertRelativeToAbsoluteSegmentOffsets(
              DASH_JSON.MPD,
              segmentTemplate,
              originalUrlQuery,
              false
            );

            if (changed) staticQueryUrl = new URLSearchParams(urlQuery);

            if (stateKey) {
              urlQuery.set('state', stateKey);
            }

            const proxy = proxyPathBuilder(
              mediaUrl.match(/^http/) ? mediaUrl : baseUrl + mediaUrl,
              urlQuery,
              hasTime
                ? 'proxy-segment/segment_$Time$_$Bandwidth$_$RepresentationID$'
                : 'proxy-segment/segment_$Number$_$Bandwidth$_$RepresentationID$'
            );
            segmentTemplate.$.media = proxy;
            // Initialization attr.
            const initUrl = segmentTemplate.$.initialization;
            if (!initUrl.match(/^http/)) {
              try {
                // Use original query url if baseUrl is undefined, combine if relative, or use just baseUrl if its absolute
                if (!baseUrl) {
                  baseUrl = originalUrlQuery.get('url');
                } else if (!baseUrl.match(/^http/)) {
                  baseUrl = new URL(baseUrl, originalUrlQuery.get('url')).href;
                }
                const absoluteInitUrl = new URL(initUrl, baseUrl).href;
                segmentTemplate.$.initialization = absoluteInitUrl;
              } catch (e) {
                throw new Error(e);
              }
            }
          } else {
            // Uses segment ids
            adaptationSet.Representation.map((representation) => {
              if (representation.SegmentTemplate) {
                representation.SegmentTemplate.map((segmentTemplate) => {
                  // Media attr.
                  const mediaUrl = segmentTemplate.$.media;
                  const hasTime = mediaUrl.toString().includes('$Time$');
                  // Convert relative segment offsets to absolute ones
                  // Also clones params to avoid mutating input argument
                  const [urlQuery, changed] =
                    convertRelativeToAbsoluteSegmentOffsets(
                      DASH_JSON.MPD,
                      segmentTemplate,
                      originalUrlQuery,
                      true
                    );

                  if (changed) staticQueryUrl = new URLSearchParams(urlQuery);

                  if (representation.$.bandwidth) {
                    urlQuery.set('bitrate', representation.$.bandwidth);
                  }

                  if (stateKey) {
                    urlQuery.set('state', stateKey);
                  }

                  const proxy = proxyPathBuilder(
                    mediaUrl,
                    urlQuery,
                    hasTime
                      ? 'proxy-segment/segment_$Time$.mp4'
                      : 'proxy-segment/segment_$Number$.mp4'
                  );
                  segmentTemplate.$.media = proxy;
                  // Initialization attr.
                  const masterDashUrl = originalUrlQuery.get('url');
                  const initUrl = segmentTemplate.$.initialization;
                  if (!initUrl.match(/^http/)) {
                    try {
                      const absoluteInitUrl = new URL(initUrl, masterDashUrl)
                        .href;
                      segmentTemplate.$.initialization = absoluteInitUrl;
                    } catch (e) {
                      throw new Error(e);
                    }
                  }
                });
              }
            });
          }
        });
      });

      if (staticQueryUrl)
        DASH_JSON.MPD.Location = 'proxy-master.mpd?' + staticQueryUrl;

      const manifest = builder.buildObject(DASH_JSON);

      return manifest;
    }
  };
}

function convertRelativeToAbsoluteSegmentOffsets(
  mpd: any,
  segmentTemplate: any,
  originalUrlQuery: URLSearchParams,
  segmentTemplateTimelineFormat: boolean
): [URLSearchParams, boolean] {
  let firstSegment: number;

  if (segmentTemplateTimelineFormat) {
    firstSegment = Number(segmentTemplate.$.startNumber);
  } else {
    // Calculate first segment number
    const walltime = new Date().getTime();
    const availabilityStartTime = new Date(
      mpd.$.availabilityStartTime
    ).getTime();

    let duration: number;
    if (segmentTemplate.$.duration) {
      duration = Number(segmentTemplate.$.duration);
    } else {
      duration = Number(segmentTemplate.SegmentTimeline[0].S[0].$.d);
    }

    const timescale = Number(
      segmentTemplate.$.timescale ? segmentTemplate.$.timescale : '1'
    );
    const startNumber = Number(segmentTemplate.$.startNumber);

    firstSegment = Math.round(
      (walltime - availabilityStartTime) / 1000 / (duration / timescale) +
        startNumber
    );
  }

  const urlQuery = new URLSearchParams(originalUrlQuery);

  const corruptions = ['statusCode', 'delay', 'timeout', 'throttle'];

  let changed = false;

  for (const corruption of corruptions) {
    const fieldsJson = urlQuery.get(corruption);

    if (fieldsJson) {
      const fields = JSON.parse(getJSONParsableString(fieldsJson));

      fields.map((field) => {
        const relativeOffset = field.rsq;

        if (relativeOffset) {
          changed = true;
          delete field.rsq;
          field.sq = firstSegment + relativeOffset;
        }
      });

      const fieldsSerialized = JSON.stringify(fields).replace(/"/g, '');
      urlQuery.set(corruption, fieldsSerialized);
    }
  }

  return [urlQuery, changed];
}

export function getJSONParsableString(value: string): string {
  return decodeURIComponent(value)
    .replace(/\s/g, '')
    .replace(
      /({|,)(?:\s*)(?:')?([A-Za-z_$.][A-Za-z0-9_ \-.$]*)(?:')?(?:\s*):/g,
      '$1"$2":'
    )
    .replace(/:\*/g, ':"*"');
}
