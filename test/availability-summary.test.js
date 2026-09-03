const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chooseEarliestSlot,
  computeEarliestAvailable,
  earliestSlotForResult,
  slotsForDashboard,
} = require("../src/availability-summary");
const {
  formatEarliestAvailable,
} = require("../src/web-server");

test("earliest slot summary keeps only date time and office name", () => {
  assert.deepEqual(earliestSlotForResult({
    office: { name: "Point Grey" },
    availableSlots: [
      {
        date: "2026-10-20",
        startTime: "09:00:00",
        endTime: "09:45:00",
        signature: "do not keep",
      },
      {
        date: "2026-10-18",
        startTime: "13:30:00",
        resourceId: "do not keep",
      },
    ],
  }), {
    date: "2026-10-18",
    startTime: "13:30:00",
    officeName: "Point Grey",
  });
});

test("earliest slot summary compares slots across offices", () => {
  const first = {
    date: "2026-10-19",
    startTime: "09:50:00",
    officeName: "Point Grey",
  };
  const second = {
    date: "2026-10-17",
    startTime: "15:10:00",
    officeName: "Burnaby",
  };

  assert.deepEqual(chooseEarliestSlot(first, second), second);
  assert.deepEqual(chooseEarliestSlot(second, null), second);
});

test("earliest slot summary is computed from all slots even when availability is not actionable", () => {
  const result = {
    available: false,
    actionableSlots: [],
    existingAppointmentDetected: true,
    currentAppointment: {
      date: "2026-10-19",
      startTime: "09:50:00",
    },
    office: { name: "Vancouver Driver Licensing (Point Grey)" },
    availableSlots: [
      {
        date: "2026-11-18",
        startTime: "09:55",
        endTime: "10:35",
      },
      {
        date: "2026-11-19",
        startTime: "08:20",
        endTime: "09:00",
      },
    ],
  };

  const earliest = computeEarliestAvailable(slotsForDashboard(result));

  assert.deepEqual(earliest, {
    date: "2026-11-18",
    startTime: "09:55",
    officeName: "Vancouver Driver Licensing (Point Grey)",
  });
  assert.equal(
    formatEarliestAvailable(earliest),
    "Nov 18, 2026 · 9:55 AM Vancouver Driver Licensing (Point Grey)",
  );
});
