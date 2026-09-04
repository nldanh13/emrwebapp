'use strict';

const { safeArray } = require('./common');

function patientCanPrint(patient) {
  if (!patient?.workflow?.isLeaving) return false;
  if (patient?.ticketStatus && !['VERIFIED', 'CLOSED', 'NO_ISSUE'].includes(patient.ticketStatus)) return false;
  if (patient?.qa?.required && patient.qa.status !== 'ok') return false;
  return (patient?.issueCounts?.errors || 0) === 0 && (patient?.issueCounts?.warnings || 0) === 0;
}

function buildPrintGuard(patients) {
  const leaving = safeArray(patients).filter(p => p?.workflow?.isLeaving);
  const blockers = leaving.filter(p => !patientCanPrint(p)).map(p => ({
    patientId: p.patientId,
    patientName: p.profile?.name || p.patientName || '',
    room: p.profile?.room || '',
    status: p.workflowStatus,
    ticketStatus: p.ticketStatus || 'NONE',
    errors: p.issueCounts?.errors || 0,
    warnings: p.issueCounts?.warnings || 0,
  }));
  return {
    canPrintAll: leaving.length > 0 && blockers.length === 0,
    leavingCount: leaving.length,
    readyCount: leaving.length - blockers.length,
    blockers,
  };
}

module.exports = { patientCanPrint, buildPrintGuard };
