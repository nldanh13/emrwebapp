import { describe, expect, it } from 'vitest';
import { parseSseChunk } from './WorkspaceRealtimeBridge.jsx';

describe('WorkspaceRealtimeBridge SSE parser', () => {
  it('parses complete events and keeps partial tail', () => {
    const rows = [];
    const rest = parseSseChunk(
      'event: task\ndata: {"status":"running","task_id":"1"}\n\n' +
      'event: task\ndata: {"status":"suc',
      (name, payload) => rows.push([name, payload]),
    );
    expect(rows).toEqual([['task', { status: 'running', task_id: '1' }]]);
    expect(rest).toBe('event: task\ndata: {"status":"suc');
  });

  it('handles CRLF streams', () => {
    const rows = [];
    const normalized = 'event: workspace_snapshot\r\ndata: {"workspace":"abc123"}\r\n\r\n'.replace(/\r\n/g, '\n');
    const rest = parseSseChunk(normalized, (name, payload) => rows.push([name, payload]));
    expect(rest).toBe('');
    expect(rows[0][0]).toBe('workspace_snapshot');
    expect(rows[0][1].workspace).toBe('abc123');
  });
});
