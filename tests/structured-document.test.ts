import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectStructuredPin } from '../agent/lib/container-egress.ts';
import {
  STRUCTURED_DOCUMENT_PATH,
  STRUCTURED_DOCUMENT_URL,
  acceptStructuredCapture,
  structuredFetchCommand,
} from '../scripts/structured-document.ts';

test('the structured document command is one pinned GET of /3/', () => {
  const command = structuredFetchCommand('151.101.128.223', 4);
  assert.equal(command.op, 'fetch');
  assert.equal(command.path, '/3/');
  assert.equal(STRUCTURED_DOCUMENT_PATH, '/3/');
  assert.equal(STRUCTURED_DOCUMENT_URL, 'https://docs.python.org/3/');
  assert.equal(command.servername, 'docs.python.org');
  assert.equal(command.hostHeader, 'docs.python.org');
  assert.equal(command.port, 443);
  assert.equal(command.https, true);
  assert.equal(command.address, '151.101.128.223');
  assert.throws(() => structuredFetchCommand('10.1.1.1', 4));
  assert.throws(() => structuredFetchCommand('151.101.128.223', 6));
  const answers = ['2a04:4e42::223', '151.101.0.223', '151.101.128.223'];
  assert.equal(selectStructuredPin(answers), '151.101.0.223');
  assert.equal(selectStructuredPin(answers, '151.101.128.223'), '151.101.128.223');
  assert.throws(() => selectStructuredPin(answers, '151.101.64.223'));
  assert.throws(() => selectStructuredPin(['10.1.1.1']));
  assert.equal(acceptStructuredCapture({
    status: 200, address: '151.101.128.223', auditPass: true,
    dials: [{ address: '151.101.128.223', port: 443 }],
  }), true);
  assert.equal(acceptStructuredCapture({
    status: 301, address: '151.101.128.223', auditPass: true, location: 'https://docs.python.org/3/index.html',
    dials: [{ address: '151.101.128.223', port: 443 }],
  }), false);
  assert.equal(acceptStructuredCapture({
    status: 200, address: '151.101.128.223', auditPass: false,
    dials: [{ address: '151.101.128.223', port: 443 }],
  }), false);
  assert.equal(acceptStructuredCapture({
    status: 200, address: '151.101.128.223', auditPass: true,
    dials: [{ address: '151.101.128.223', port: 443 }, { address: '151.101.0.223', port: 443 }],
  }), false);
  const fetchSource = readFileSync(new URL('../scripts/fetch-structured-page.ts', import.meta.url), 'utf8');
  const documentSource = readFileSync(new URL('../scripts/structured-document.ts', import.meta.url), 'utf8');
  assert.equal(fetchSource.match(/network\.request\(/g)?.length, 1);
  assert.ok(fetchSource.indexOf('already attempted') < fetchSource.indexOf('network.request('));
  assert.equal(documentSource.includes("'/3/'"), true);
  assert.equal(fetchSource.includes('/3/index.html'), false);
  assert.equal(fetchSource.includes('devguide.python.org'), false);
});
