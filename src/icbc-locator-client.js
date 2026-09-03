const { getRoadTestLocationByLocatorKey } = require("./locations");

const ICBC_LOCATOR_URL = "https://icbc.com/locators";
const DRIVER_LICENSING_SERVICE_TYPE = "driver-licensing-office";

class IcbcLocatorError extends Error {
  constructor(message, { code, cause = null } = {}) {
    super(message);
    this.name = "IcbcLocatorError";
    this.code = code;
    this.publicMessage = "ICBC location search is temporarily unavailable. Please try again later.";
    if (cause) {
      this.cause = cause;
    }
  }
}

class IcbcLocatorClient {
  constructor({ fetchImpl = globalThis.fetch, logger = console, locatorUrl = ICBC_LOCATOR_URL } = {}) {
    this.fetch = fetchImpl;
    this.logger = logger;
    this.locatorUrl = locatorUrl;
  }

  async searchDriverLicensingLocations(postalCode) {
    try {
      const formFields = await this.fetchSearchFormFields();
      const formData = new FormData();
      for (const [name, value] of formFields) {
        formData.set(name, value);
      }

      formData.set("serviceType", DRIVER_LICENSING_SERVICE_TYPE);
      formData.set("hoursPreset", formData.get("hoursPreset") || "0");
      formData.set("defaultLat", formData.get("defaultLat") || "53.7267");
      formData.set("defaultLng", formData.get("defaultLng") || "-127.6476");
      formData.set("address", postalCode);

      const response = await this.fetch(this.locatorUrl, {
        method: "POST",
        headers: {
          "User-Agent": "appointment-availability-monitor/1.0",
          Accept: "text/html, text/x-component;q=0.9, */*;q=0.8",
          Referer: this.locatorUrl,
          Origin: new URL(this.locatorUrl).origin,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new IcbcLocatorError(`ICBC locator search failed with HTTP ${response.status}`, { code: "locator-post-http" });
      }

      const body = await response.text();
      const locations = parseIcbcStructuredLocations(body);
      if (locations.length === 0) {
        throw new IcbcLocatorError("ICBC locator response did not contain structured locations", { code: "locator-empty-structured-response" });
      }

      return {
        postalCode,
        locations,
        monitorableLocations: parseIcbcLocatorLocations(body),
      };
    } catch (error) {
      if (error instanceof IcbcLocatorError) {
        throw error;
      }

      throw new IcbcLocatorError("ICBC locator search failed", { code: "locator-search-failed", cause: error });
    }
  }

  async fetchSearchFormFields() {
    try {
      const response = await this.fetch(this.locatorUrl, {
        headers: {
          "User-Agent": "appointment-availability-monitor/1.0",
          Accept: "text/html",
        },
      });

      if (!response.ok) {
        throw new IcbcLocatorError(`ICBC locator form fetch failed with HTTP ${response.status}`, { code: "locator-form-http" });
      }

      const html = await response.text();
      const fields = parseLocatorFormFields(html);
      if (![...fields.keys()].some(name => name.startsWith("$ACTION_"))) {
        throw new IcbcLocatorError("ICBC locator form did not expose Next.js action fields", { code: "locator-action-fields-missing" });
      }

      return fields;
    } catch (error) {
      if (error instanceof IcbcLocatorError) {
        throw error;
      }

      throw new IcbcLocatorError("ICBC locator form fetch failed", { code: "locator-form-fetch-failed", cause: error });
    }
  }
}

function parseLocatorFormFields(html) {
  const fields = new Map();
  for (const inputTag of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = getHtmlAttribute(inputTag[0], "name");
    if (!name) {
      continue;
    }

    fields.set(name, getHtmlAttribute(inputTag[0], "value") || "");
  }

  return fields;
}

function parseIcbcLocatorLocations(payload) {
  return parseIcbcStructuredLocations(payload)
    .map(toMonitorableLocation)
    .filter(Boolean);
}

function parseIcbcStructuredLocations(payload) {
  const normalized = normalizeTransportText(payload);
  const locations = [];
  const seen = new Set();

  for (const rawLocation of extractLocationRecords(normalized)) {
    if (!rawLocation || typeof rawLocation.key !== "string" || seen.has(rawLocation.key)) {
      continue;
    }

    const coords = rawLocation.location || {};
    if (!Number.isFinite(Number(coords.lat)) || !Number.isFinite(Number(coords.lng))) {
      continue;
    }

    seen.add(rawLocation.key);
    locations.push(rawLocation);
  }

  return locations;
}

function extractLocationRecords(text) {
  const records = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerIndex = text.indexOf('"locations":[', searchFrom);
    if (markerIndex === -1) {
      break;
    }

    const arrayStart = text.indexOf("[", markerIndex);
    const arrayText = extractBalancedJson(text, arrayStart);
    if (arrayText) {
      try {
        const parsed = JSON.parse(arrayText);
        if (Array.isArray(parsed)) {
          records.push(...parsed);
        }
      } catch (error) {
        // Continue scanning; ICBC also embeds escaped render payloads nearby.
      }
    }

    searchFrom = markerIndex + 12;
  }

  return records;
}

function extractBalancedJson(text, startIndex) {
  if (startIndex < 0 || text[startIndex] !== "[") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function toMonitorableLocation(rawLocation) {
  const catalog = getRoadTestLocationByLocatorKey(rawLocation.key);
  if (!catalog) {
    return null;
  }

  return {
    id: catalog.id,
    locatorKey: catalog.locatorKey,
    displayName: String(rawLocation.businessName || "").trim(),
    address: [rawLocation.addressLine1, rawLocation.addressLine2].filter(Boolean).map(value => String(value).trim()).join(", "),
    city: String(rawLocation.city || "").trim(),
    postalCode: rawLocation.postalCode || null,
    latitude: Number(rawLocation.location.lat),
    longitude: Number(rawLocation.location.lng),
    primaryPhone: rawLocation.primaryPhone || null,
    secondaryPhone: rawLocation.secondaryPhone || null,
    rawJson: JSON.stringify(rawLocation),
    bookingVerificationStatus: catalog.verificationStatus,
    bookingVerificationNotes: catalog.verificationNotes,
    bookingSearchText: catalog.bookingSearchText,
    bookingOptionPattern: catalog.bookingOptionPattern.source,
    source: "icbc-locator-post",
  };
}

function normalizeTransportText(text) {
  return decodeHtmlEntities(String(text || ""))
    .replace(/\\"/g, "\"")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\n/g, "\n");
}

function getHtmlAttribute(tag, attributeName) {
  const pattern = new RegExp(`\\b${attributeName}=("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tag);
  if (!match) {
    return null;
  }

  return decodeHtmlEntities(match[2] || match[3] || match[4] || "");
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#x22;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

module.exports = {
  DRIVER_LICENSING_SERVICE_TYPE,
  ICBC_LOCATOR_URL,
  IcbcLocatorError,
  IcbcLocatorClient,
  parseIcbcLocatorLocations,
  parseIcbcStructuredLocations,
  parseLocatorFormFields,
};
