function earliestSlotForResult(result) {
  return computeEarliestAvailable(slotsForDashboard(result));
}

function slotsForDashboard(result) {
  if (!result || !Array.isArray(result.availableSlots) || result.availableSlots.length === 0) {
    return [];
  }

  const officeName = result.office && result.office.name ? String(result.office.name) : null;
  return result.availableSlots
    .map(slot => normalizeDashboardSlot(slot, officeName))
    .filter(Boolean);
}

function computeEarliestAvailable(slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return null;
  }

  return slots
    .map(slot => normalizeDashboardSlot(slot, slot.officeName))
    .filter(Boolean)
    .sort(compareDashboardSlots)[0] || null;
}

function chooseEarliestSlot(current, candidate) {
  if (!current) {
    return candidate || null;
  }

  if (!candidate) {
    return current;
  }

  return compareDashboardSlots(candidate, current) < 0 ? candidate : current;
}

function normalizeDashboardSlot(slot, officeName) {
  if (!slot || !slot.date || !slot.startTime) {
    return null;
  }

  return {
    date: String(slot.date),
    startTime: String(slot.startTime),
    officeName,
  };
}

function compareDashboardSlots(a, b) {
  const first = toDateTime(a && a.date, a && a.startTime);
  const second = toDateTime(b && b.date, b && b.startTime);
  if (!first && !second) {
    return 0;
  }

  if (!first) {
    return 1;
  }

  if (!second) {
    return -1;
  }

  return first.getTime() - second.getTime();
}

function toDateTime(date, time) {
  if (!date || !time) {
    return null;
  }

  const parsed = new Date(`${date}T${normalizeTime(time)}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeTime(time) {
  const value = String(time);
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return `${value}:00`;
  }

  if (/^\d{4}$/.test(value)) {
    return `${value.slice(0, 2)}:${value.slice(2)}:00`;
  }

  return value;
}

module.exports = {
  chooseEarliestSlot,
  computeEarliestAvailable,
  earliestSlotForResult,
  slotsForDashboard,
};
