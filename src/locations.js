const DEFAULT_VERIFICATION_STATUS = "manual-unverified";
const DEFAULT_VERIFICATION_NOTES = [
  "Seeded from ICBC driver-licensing locator keys and booking-search text.",
  "Not yet live-verified by an automated booking-workflow inventory job.",
].join(" ");

// This is not a province-wide office list. It is a manually seeded candidate list
// used to filter ICBC locator results to offices the checker knows how to try in
// the road-test booking autocomplete. Entries should move to a stronger status
// only after a live booking-workflow verification confirms them.
const MANUAL_ROAD_TEST_SEARCH_CANDIDATES = [
  {
    id: "icbc-FpEniQaRrcvuGf8e7OjD1",
    locatorKey: "FpEniQaRrcvuGf8e7OjD1",
    bookingSearchText: "Burnaby driver licensing",
    bookingOptionPattern: /Burnaby driver licensing/i,
  },
  {
    id: "icbc-4KZDuqYyBJQU2A2nyb3WWY",
    locatorKey: "4KZDuqYyBJQU2A2nyb3WWY",
    bookingSearchText: "Burnaby Driver Licensing Lougheed",
    bookingOptionPattern: /Burnaby.*Lougheed/i,
  },
  {
    id: "icbc-5SR5Xd56VAxNeIMJE5W9Xj",
    locatorKey: "5SR5Xd56VAxNeIMJE5W9Xj",
    bookingSearchText: "Burnaby Claims Centre",
    bookingOptionPattern: /Burnaby Claims Centre/i,
  },
  {
    id: "icbc-1te3OtTE2mkvTX2TCMgdYN",
    locatorKey: "1te3OtTE2mkvTX2TCMgdYN",
    bookingSearchText: "Vancouver Driver Licensing Commercial Drive",
    bookingOptionPattern: /Vancouver.*Commercial Drive/i,
  },
  {
    id: "icbc-6rPPNEzEnVv1dEyQnqCsAA",
    locatorKey: "6rPPNEzEnVv1dEyQnqCsAA",
    bookingSearchText: "Vancouver Driver Licensing Point Grey",
    bookingOptionPattern: /Vancouver.*Point Grey/i,
  },
  {
    id: "icbc-5lE63ibb8uSFsrLp3SfoC4",
    locatorKey: "5lE63ibb8uSFsrLp3SfoC4",
    bookingSearchText: "Vancouver Driver Licensing Royal Centre",
    bookingOptionPattern: /Vancouver.*Royal Centre/i,
  },
  {
    id: "icbc-7sPJpSKLb1bigDu7CXDCXv",
    locatorKey: "7sPJpSKLb1bigDu7CXDCXv",
    bookingSearchText: "Vancouver Kingsway Claims Centre",
    bookingOptionPattern: /Vancouver Kingsway Claims Centre/i,
  },
  {
    id: "icbc-56U2IDd1ftD7JMA6x0liPt",
    locatorKey: "56U2IDd1ftD7JMA6x0liPt",
    bookingSearchText: "Richmond Driver Licensing",
    bookingOptionPattern: /Richmond Driver Licensing/i,
  },
  {
    id: "icbc-3an2ViZh7hqRFTjLWLHbRj",
    locatorKey: "3an2ViZh7hqRFTjLWLHbRj",
    bookingSearchText: "North Vancouver Driver Licensing",
    bookingOptionPattern: /North Vancouver Driver Licensing/i,
  },
  {
    id: "icbc-iWTOGXbhB9MIWjTKrffKu",
    locatorKey: "iWTOGXbhB9MIWjTKrffKu",
    bookingSearchText: "Guildford Driver Licensing",
    bookingOptionPattern: /Guildford Driver Licensing/i,
  },
  {
    id: "icbc-5mmcDNLGOGWHks8PMZjt8K",
    locatorKey: "5mmcDNLGOGWHks8PMZjt8K",
    bookingSearchText: "Surrey Driver Licensing 78th Ave",
    bookingOptionPattern: /Surrey.*78th/i,
  },
  {
    id: "icbc-3xoaKEJKAHl3BVRSgmqsOP",
    locatorKey: "3xoaKEJKAHl3BVRSgmqsOP",
    bookingSearchText: "Surrey Guildford Claims Centre",
    bookingOptionPattern: /Surrey Guildford Claims Centre/i,
  },
  {
    id: "icbc-xSnmWmdk6UKZXHPgaNt2w",
    locatorKey: "xSnmWmdk6UKZXHPgaNt2w",
    bookingSearchText: "Surrey Newton Claims Centre",
    bookingOptionPattern: /Surrey Newton Claims Centre/i,
  },
  {
    id: "icbc-3WtaedMdoArUKWk2B4Iaor",
    locatorKey: "3WtaedMdoArUKWk2B4Iaor",
    bookingSearchText: "Guildford Boardwalk Road Test Centre",
    bookingOptionPattern: /Guildford Boardwalk Road Test Centre/i,
  },
  {
    id: "icbc-GYCqL4Ll1ypqripMFdA7x",
    locatorKey: "GYCqL4Ll1ypqripMFdA7x",
    bookingSearchText: "Port Coquitlam Driver Licensing",
    bookingOptionPattern: /Port Coquitlam Driver Licensing/i,
  },
  {
    id: "icbc-wqn8r0YHrKyqHLTzfdnIT",
    locatorKey: "wqn8r0YHrKyqHLTzfdnIT",
    bookingSearchText: "Langley Willowbrook Driver Licensing",
    bookingOptionPattern: /Langley Willowbrook Driver Licensing/i,
  },
  {
    id: "icbc-2oRvNbTqYP7WgId8Bj8NP9",
    locatorKey: "2oRvNbTqYP7WgId8Bj8NP9",
    bookingSearchText: "Maple Ridge Claims Centre",
    bookingOptionPattern: /Maple Ridge Claims Centre/i,
  },
  {
    id: "icbc-5LKiUrGrICrb9YmbXvBU0I",
    locatorKey: "5LKiUrGrICrb9YmbXvBU0I",
    bookingSearchText: "Abbotsford Driver Licensing",
    bookingOptionPattern: /Abbotsford Driver Licensing/i,
  },
  {
    id: "icbc-U14qrIRLuD6h0C32rPi73",
    locatorKey: "U14qrIRLuD6h0C32rPi73",
    bookingSearchText: "Chilliwack Driver Licensing",
    bookingOptionPattern: /Chilliwack Driver Licensing/i,
  },
  {
    id: "icbc-1SVvMNbM2T40lJyq2bNG9g",
    locatorKey: "1SVvMNbM2T40lJyq2bNG9g",
    bookingSearchText: "Squamish Claims Centre",
    bookingOptionPattern: /Squamish Claims Centre/i,
  },
  {
    id: "icbc-11sAIHtcwIfqAgpGZ00BzW",
    locatorKey: "11sAIHtcwIfqAgpGZ00BzW",
    bookingSearchText: "Langford Road Test Unit",
    bookingOptionPattern: /Langford Road Test Unit/i,
  },
  {
    id: "icbc-6ieWpa4PFADwQQEIn9Z3OV",
    locatorKey: "6ieWpa4PFADwQQEIn9Z3OV",
    bookingSearchText: "Saanich Driver Licensing",
    bookingOptionPattern: /Saanich Driver Licensing/i,
  },
  {
    id: "icbc-14Vd33vMEnME9mFZ1YIO1f",
    locatorKey: "14Vd33vMEnME9mFZ1YIO1f",
    bookingSearchText: "Victoria Driver Licensing Wharf",
    bookingOptionPattern: /Victoria.*Wharf/i,
  },
  {
    id: "icbc-3Jr358CfOm6DfZ1mTGRtd4",
    locatorKey: "3Jr358CfOm6DfZ1mTGRtd4",
    bookingSearchText: "Sidney Driver Licensing",
    bookingOptionPattern: /Sidney Driver Licensing/i,
  },
  {
    id: "icbc-7mAoQqE90IAIaPVLbDNvVl",
    locatorKey: "7mAoQqE90IAIaPVLbDNvVl",
    bookingSearchText: "Nanaimo Driver Licensing",
    bookingOptionPattern: /Nanaimo Driver Licensing/i,
  },
  {
    id: "icbc-3s4cCIf4oYHwF3FFGdcEuw",
    locatorKey: "3s4cCIf4oYHwF3FFGdcEuw",
    bookingSearchText: "Kelowna Driver Licensing",
    bookingOptionPattern: /Kelowna Driver Licensing/i,
  },
  {
    id: "icbc-31gfqYiK6f1ScyE8WQayyo",
    locatorKey: "31gfqYiK6f1ScyE8WQayyo",
    bookingSearchText: "West Kelowna driver licensing",
    bookingOptionPattern: /West Kelowna.*driver licensing/i,
  },
  {
    id: "icbc-5iN9z64nlxI6h4qT8yoH8o",
    locatorKey: "5iN9z64nlxI6h4qT8yoH8o",
    bookingSearchText: "Kamloops Driver Licensing",
    bookingOptionPattern: /Kamloops Driver Licensing/i,
  },
  {
    id: "icbc-1pnSUz8Jnd6IZ1ciirO20S",
    locatorKey: "1pnSUz8Jnd6IZ1ciirO20S",
    bookingSearchText: "Prince George Driver Licensing",
    bookingOptionPattern: /Prince George Driver Licensing/i,
  },
  {
    id: "icbc-5O6xHanLgiccIsq7IrKwKT",
    locatorKey: "5O6xHanLgiccIsq7IrKwKT",
    bookingSearchText: "Fort St John Claims Centre",
    bookingOptionPattern: /Fort St\.? John Claims Centre/i,
  },
];

const ROAD_TEST_LOCATION_CATALOG = MANUAL_ROAD_TEST_SEARCH_CANDIDATES.map(location => ({
  verificationStatus: DEFAULT_VERIFICATION_STATUS,
  verificationNotes: DEFAULT_VERIFICATION_NOTES,
  ...location,
}));

const CATALOG_BY_ID = new Map(ROAD_TEST_LOCATION_CATALOG.map(location => [location.id, location]));
const CATALOG_BY_LOCATOR_KEY = new Map(ROAD_TEST_LOCATION_CATALOG.map(location => [location.locatorKey, location]));

function getRoadTestLocationById(id) {
  return CATALOG_BY_ID.get(id) || null;
}

function getRoadTestLocationByLocatorKey(locatorKey) {
  return CATALOG_BY_LOCATOR_KEY.get(locatorKey) || null;
}

function isMonitorableLocationId(id) {
  return CATALOG_BY_ID.has(id);
}

module.exports = {
  DEFAULT_VERIFICATION_STATUS,
  MANUAL_ROAD_TEST_SEARCH_CANDIDATES,
  ROAD_TEST_LOCATION_CATALOG,
  getRoadTestLocationById,
  getRoadTestLocationByLocatorKey,
  isMonitorableLocationId,
};
