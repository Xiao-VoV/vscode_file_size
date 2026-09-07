import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes } from './format.js';

describe('formatBytes', () => {
  it('renders zero and small values', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  it('renders base-1024 units', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(5 * 1024 * 1024 * 1024), '5.0 GB');
  });

  it('treats invalid input as zero', () => {
    assert.equal(formatBytes(NaN), '0 B');
    assert.equal(formatBytes(Infinity), '0 B');
    assert.equal(formatBytes(-100), '0 B');
  });

  it('honours custom decimals', () => {
    assert.equal(formatBytes(1536, 0), '2 KB');
    assert.equal(formatBytes(1536, 2), '1.50 KB');
  });
});