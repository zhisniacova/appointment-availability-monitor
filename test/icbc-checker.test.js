const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAvailabilityHash,
  classifyPostLoginState,
  extractAvailableAppointmentSlots,
  findActiveAppointment,
  isSlotEarlierThanCurrent,
  parseCurrentAppointmentText,
} = require("../src/icbc-checker");

test("post-login state distinguishes ordinary booking flow from existing appointment flow", () => {
  assert.equal(classifyPostLoginState({
    searchVisible: true,
    existingAppointmentVisible: false,
    activeAppointment: null,
  }), "booking-search");

  assert.equal(classifyPostLoginState({
    searchVisible: false,
    existingAppointmentVisible: true,
    activeAppointment: null,
  }), "existing-appointment");

  assert.equal(classifyPostLoginState({
    searchVisible: false,
    existingAppointmentVisible: false,
    activeAppointment: { date: "2026-10-10", startTime: "09:00:00" },
  }), "existing-appointment");
});

test("current appointment parsing keeps only the active appointment fields needed for earlier checks", () => {
  const payload = {
    driver: {
      name: "Do not keep",
      webAappointments: [
        {
          bookedIndicator: "CANCELLED",
          appointmentDt: { date: "2026-10-01" },
          startTm: "09:00:00",
        },
        {
          bookedIndicator: "ACTIVE",
          appointmentDt: { date: "2026-10-15" },
          startTm: "11:00:00",
          endTm: "11:45:00",
          dlExam: { code: "5-R-1", description: "Class 5 road test" },
          posName: "Point Grey",
          posGeo: {
            agency: "ICBC",
            address: "4126 MacDonald Street",
            posId: 123,
            unrelated: "do not keep",
          },
          signature: "do not keep",
        },
      ],
    },
  };

  assert.deepEqual(findActiveAppointment(payload), {
    date: "2026-10-15",
    startTime: "11:00:00",
    endTime: "11:45:00",
    exam: { code: "5-R-1", description: "Class 5 road test" },
    office: {
      name: "Point Grey",
      agency: "ICBC",
      address: "4126 MacDonald Street",
      posId: 123,
    },
  });
});

test("current appointment parsing tolerates nested and case-varied appointment arrays", () => {
  const payload = {
    result: {
      driverEnvelope: {
        WebAappointments: [
          {
            bookedIndicator: "active",
            appointmentDt: { date: "2026-10-20" },
            startTm: "08:15:00",
            endTm: "09:00:00",
            dlExam: { code: "7-R-1", description: "Class 7 road test" },
            posName: "Point Grey",
            posGeo: { agency: "ICBC", address: "4126 MacDonald Street", posId: 0 },
            driverProfile: { name: "Do not keep" },
          },
        ],
      },
    },
  };

  assert.deepEqual(findActiveAppointment(payload), {
    date: "2026-10-20",
    startTime: "08:15:00",
    endTime: "09:00:00",
    exam: { code: "7-R-1", description: "Class 7 road test" },
    office: {
      name: "Point Grey",
      agency: "ICBC",
      address: "4126 MacDonald Street",
      posId: 0,
    },
  });
});

test("current appointment page fallback parses ICBC-style date and time text", () => {
  assert.deepEqual(parseCurrentAppointmentText("Your upcoming appointment is October 15, 2026 at 10:15 a.m."), {
    date: "2026-10-15",
    startTime: "10:15:00",
  });
});

test("available appointment parsing omits signatures and compares against current appointment", () => {
  const payload = {
    result: {
      slots: [
        {
          appointmentDt: { date: "2026-10-16", dayOfWeek: "Friday" },
          startTm: "09:00:00",
          endTm: "09:45:00",
          dlExam: { code: "5-R-1" },
          posId: 456,
          signature: "do not keep",
        },
        {
          appointmentDt: { date: "2026-10-10", dayOfWeek: "Saturday" },
          startTm: "13:30:00",
          endTm: "14:15:00",
          dlExam: { code: "5-R-1" },
          posId: 456,
        },
      ],
    },
  };

  const slots = extractAvailableAppointmentSlots(payload);
  const currentAppointment = { date: "2026-10-15", startTime: "11:00:00" };

  assert.deepEqual(slots, [
    {
      date: "2026-10-10",
      dayOfWeek: "Saturday",
      startTime: "13:30:00",
      endTime: "14:15:00",
      examCode: "5-R-1",
      posId: "456",
    },
    {
      date: "2026-10-16",
      dayOfWeek: "Friday",
      startTime: "09:00:00",
      endTime: "09:45:00",
      examCode: "5-R-1",
      posId: "456",
    },
  ]);
  assert.equal(Object.hasOwn(slots[0], "signature"), false);
  assert.equal(isSlotEarlierThanCurrent(slots[0], currentAppointment), true);
  assert.equal(isSlotEarlierThanCurrent(slots[1], currentAppointment), false);
  assert.equal(buildAvailabilityHash({
    officeId: "office-1",
    available: true,
    actionableSlots: [slots[0]],
    appointments: [],
  }), "office-1:available:2026-10-10|13:30:00|14:15:00");
});
