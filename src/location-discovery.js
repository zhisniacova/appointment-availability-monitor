const { IcbcLocatorClient, parseIcbcLocatorLocations } = require("./icbc-locator-client");
const { normalizePostalCode } = require("./postal-code");

class LocationDiscovery {
  constructor({ storage, config, logger, locatorClient = null }) {
    this.storage = storage;
    this.config = config;
    this.logger = logger;
    this.locatorClient = locatorClient || new IcbcLocatorClient({ logger });
  }

  async findNearby(postalCodeInput, requestedLimit = null) {
    const postalCode = normalizePostalCode(postalCodeInput);
    if (!postalCode) {
      return { ok: false, reason: "invalid-postal-code" };
    }

    const resultLimit = requestedLimit || this.config.initialLocationResultLimit;
    const search = await this.getOrRefreshSearch(postalCode);
    const orderedLocations = this.getOrderedLocations(search.locationIds);
    const visibleLocations = orderedLocations.slice(0, resultLimit).map((location, index) => ({
      ...location,
      locatorOrder: index,
    }));

    return {
      ok: true,
      postalCode,
      locations: visibleLocations,
      resultLimit,
      hasMore: orderedLocations.length > visibleLocations.length,
      totalMonitorable: orderedLocations.length,
      expanded: resultLimit > this.config.initialLocationResultLimit,
    };
  }

  async getOrRefreshSearch(postalCode) {
    const cached = this.storage.getLocationSearchCache(postalCode, this.config.locatorCacheTtlMs);
    if (cached) {
      return cached;
    }

    const staleCached = this.storage.getLocationSearchCache(postalCode, null);
    try {
      const searchResult = await this.locatorClient.searchDriverLicensingLocations(postalCode);
      const monitorableLocations = searchResult.monitorableLocations;
      this.storage.upsertLocations(monitorableLocations);

      const search = {
        postalCode,
        origin: null,
        locationIds: monitorableLocations.map(location => location.id),
      };
      this.storage.upsertLocationSearchCache(search);
      this.logger.info("refreshed ICBC postal-code location search", {
        postalCode,
        returnedCount: searchResult.locations.length,
        monitorableCount: search.locationIds.length,
      });
      return search;
    } catch (error) {
      if (staleCached) {
        this.logger.warn("using stale ICBC postal-code location search", { postalCode, error: error.message });
        return staleCached;
      }

      throw error;
    }
  }

  getOrderedLocations(locationIds) {
    const locationsById = new Map(this.storage.getLocationsByIds(locationIds).map(location => [location.id, location]));
    return locationIds.map(locationId => locationsById.get(locationId)).filter(Boolean);
  }
}

module.exports = {
  LocationDiscovery,
  parseIcbcLocatorLocations,
};
