const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LocationDiscovery, parseIcbcLocatorLocations } = require("../src/location-discovery");
const { Storage } = require("../src/storage");

function tempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icbc-monitor-test-"));
  return new Storage(path.join(dir, "test.sqlite"));
}

test("parses only allowlisted road-test locations from ICBC locator payload", () => {
  const html = `
    <script>self.__next_f.push([1,"{\\"locations\\":[{\\"key\\":\\"FpEniQaRrcvuGf8e7OjD1\\",\\"businessName\\":\\"Burnaby Driver Licensing (Metrotown - located under the Food Court)\\",\\"location\\":{\\"lng\\":-122.9993248,\\"lat\\":49.22662252},\\"contentRef\\":\\"FpEniQaRrcvuGf8e7OjD1\\",\\"addressLine1\\":\\"232 - 4820 Kingsway    \\",\\"addressLine2\\":null,\\"city\\":\\"Burnaby\\"},{\\"key\\":\\"not-monitorable\\",\\"businessName\\":\\"General ICBC Office\\",\\"location\\":{\\"lng\\":-123,\\"lat\\":49},\\"contentRef\\":\\"not-monitorable\\",\\"addressLine1\\":\\"1 Main St\\",\\"addressLine2\\":null,\\"city\\":\\"Vancouver\\"}]}"])</script>
  `;

  const locations = parseIcbcLocatorLocations(html);

  assert.equal(locations.length, 1);
  assert.equal(locations[0].id, "icbc-FpEniQaRrcvuGf8e7OjD1");
  assert.equal(locations[0].displayName, "Burnaby Driver Licensing (Metrotown - located under the Food Court)");
  assert.equal(locations[0].city, "Burnaby");
});

test("location discovery uses ICBC postal-code search order and cached monitorable locations", async () => {
  const storage = tempStorage();
  let searches = 0;
  const locatorClient = {
    async searchDriverLicensingLocations(postalCode) {
      searches += 1;
      assert.equal(postalCode, "V5H 2N2");
      return {
        locations: [
          {
            key: "not-monitorable",
            businessName: "Nearest insurance agent",
            location: { lat: 49.226, lng: -123 },
            city: "Burnaby",
          },
          {
            key: "FpEniQaRrcvuGf8e7OjD1",
            businessName: "Burnaby Driver Licensing",
            location: { lat: 49.22662252, lng: -122.9993248 },
            contentRef: "FpEniQaRrcvuGf8e7OjD1",
            addressLine1: "232 - 4820 Kingsway",
            addressLine2: null,
            city: "Burnaby",
          },
        ],
        monitorableLocations: [
          {
            id: "icbc-FpEniQaRrcvuGf8e7OjD1",
            locatorKey: "FpEniQaRrcvuGf8e7OjD1",
            displayName: "Burnaby Driver Licensing",
            address: "232 - 4820 Kingsway",
            city: "Burnaby",
            postalCode: null,
            latitude: 49.22662252,
            longitude: -122.9993248,
            primaryPhone: "8009501498",
            secondaryPhone: null,
            rawJson: "{}",
            bookingSearchText: "Burnaby driver licensing",
            bookingOptionPattern: "Burnaby driver licensing",
            source: "test",
          },
        ],
      };
    },
  };

  const discovery = new LocationDiscovery({
    storage,
    locatorClient,
    config: {
      initialLocationResultLimit: 8,
      expandedLocationResultLimit: 20,
      locatorCacheTtlMs: 60_000,
    },
    logger: { warn() {}, info() {} },
  });

  try {
    const first = await discovery.findNearby("v5h2n2");
    const second = await discovery.findNearby("V5H 2N2");

    assert.equal(first.ok, true);
    assert.equal(first.locations.length, 1);
    assert.equal(first.locations[0].locator_key, "FpEniQaRrcvuGf8e7OjD1");
    assert.equal(first.hasMore, false);
    assert.equal(second.locations.length, 1);
    assert.equal(searches, 1);
  } finally {
    storage.close();
  }
});
