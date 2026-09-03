const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DRIVER_LICENSING_SERVICE_TYPE,
  IcbcLocatorError,
  IcbcLocatorClient,
  parseIcbcLocatorLocations,
  parseIcbcStructuredLocations,
  parseLocatorFormFields,
} = require("../src/icbc-locator-client");

test("parses dynamic Next.js locator action fields from ICBC form HTML", () => {
  const fields = parseLocatorFormFields(`
    <form method="POST">
      <input type="hidden" name="$ACTION_REF_1"/>
      <input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;dynamic-id&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/>
      <input type="hidden" name="$ACTION_KEY" value="dynamic-key"/>
      <input type="hidden" name="serviceType" value="driver-licensing-office"/>
      <input type="hidden" name="hoursPreset" value="0"/>
    </form>
  `);

  assert.equal(fields.get("$ACTION_REF_1"), "");
  assert.equal(fields.get("$ACTION_1:0"), '{"id":"dynamic-id","bound":"$@1"}');
  assert.equal(fields.get("$ACTION_KEY"), "dynamic-key");
  assert.equal(fields.get("serviceType"), DRIVER_LICENSING_SERVICE_TYPE);
});

test("extracts structured ICBC locator records and filters to booking-capable allowlist", () => {
  const payload = `
    <input type="hidden" name="$ACTION_1:1" value="[{&quot;data&quot;:{&quot;locations&quot;:[
      {&quot;key&quot;:&quot;FpEniQaRrcvuGf8e7OjD1&quot;,&quot;businessName&quot;:&quot;Burnaby Driver Licensing&quot;,&quot;location&quot;:{&quot;lng&quot;:-122.9993248,&quot;lat&quot;:49.22662252},&quot;contentRef&quot;:&quot;FpEniQaRrcvuGf8e7OjD1&quot;,&quot;addressLine1&quot;:&quot;232 - 4820 Kingsway&quot;,&quot;addressLine2&quot;:null,&quot;city&quot;:&quot;Burnaby&quot;,&quot;primaryPhone&quot;:&quot;8009501498&quot;,&quot;secondaryPhone&quot;:null},
      {&quot;key&quot;:&quot;not-monitorable&quot;,&quot;businessName&quot;:&quot;General ICBC Office&quot;,&quot;location&quot;:{&quot;lng&quot;:-123,&quot;lat&quot;:49},&quot;contentRef&quot;:&quot;not-monitorable&quot;,&quot;addressLine1&quot;:&quot;1 Main St&quot;,&quot;addressLine2&quot;:null,&quot;city&quot;:&quot;Vancouver&quot;}
    ]}}]"/>
  `;

  const structured = parseIcbcStructuredLocations(payload);
  const monitorable = parseIcbcLocatorLocations(payload);

  assert.equal(structured.length, 2);
  assert.equal(monitorable.length, 1);
  assert.equal(monitorable[0].id, "icbc-FpEniQaRrcvuGf8e7OjD1");
  assert.equal(monitorable[0].locatorKey, "FpEniQaRrcvuGf8e7OjD1");
  assert.equal(monitorable[0].primaryPhone, "8009501498");
  assert.match(monitorable[0].rawJson, /Burnaby Driver Licensing/);
});

test("locator client posts postal-code searches with current action fields", async () => {
  const requests = [];
  const client = new IcbcLocatorClient({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (!options.method) {
        return textResponse(`
          <input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;dynamic-id&quot;}"/>
          <input type="hidden" name="$ACTION_KEY" value="dynamic-key"/>
        `);
      }

      return textResponse(`
        <script>self.__next_f.push([1,"{\\"locations\\":[{\\"key\\":\\"FpEniQaRrcvuGf8e7OjD1\\",\\"businessName\\":\\"Burnaby Driver Licensing\\",\\"location\\":{\\"lng\\":-122.9993248,\\"lat\\":49.22662252},\\"contentRef\\":\\"FpEniQaRrcvuGf8e7OjD1\\",\\"addressLine1\\":\\"232 - 4820 Kingsway\\",\\"addressLine2\\":null,\\"city\\":\\"Burnaby\\"}]}"])</script>
      `);
    },
  });

  const result = await client.searchDriverLicensingLocations("V5H 2N2");

  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.body.get("address"), "V5H 2N2");
  assert.equal(requests[1].options.body.get("serviceType"), DRIVER_LICENSING_SERVICE_TYPE);
  assert.equal(result.locations.length, 1);
  assert.equal(result.monitorableLocations.length, 1);
});

test("locator client reports missing dynamic action fields as an application error", async () => {
  const client = new IcbcLocatorClient({
    fetchImpl: async () => textResponse("<form><input name=\"address\"></form>"),
  });

  await assert.rejects(
    () => client.searchDriverLicensingLocations("V5H 2N2"),
    error => error instanceof IcbcLocatorError &&
      error.code === "locator-action-fields-missing" &&
      /temporarily unavailable/i.test(error.publicMessage),
  );
});

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}
