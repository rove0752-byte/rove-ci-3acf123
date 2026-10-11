import { isIP } from 'node:net';
import { publicAddress } from '../agent/lib/public-address.ts';

export const STRUCTURED_DOCUMENT_HOST = 'docs.python.org';
export const STRUCTURED_DOCUMENT_PATH = '/3/';
export const STRUCTURED_DOCUMENT_URL = 'https://docs.python.org/3/';

export type StructuredFetchCommand = {
  op: 'fetch';
  address: string;
  family: 4 | 6;
  port: 443;
  https: true;
  servername: typeof STRUCTURED_DOCUMENT_HOST;
  hostHeader: typeof STRUCTURED_DOCUMENT_HOST;
  path: typeof STRUCTURED_DOCUMENT_PATH;
  timeoutMs: 20_000;
};

export function structuredFetchCommand(address: string, family: 4 | 6): StructuredFetchCommand {
  if ((family !== 4 && family !== 6) || isIP(address) !== family || !publicAddress(address)) {
    throw new Error('Structured document pin is not a public address.');
  }
  return {
    op: 'fetch',
    address,
    family,
    port: 443,
    https: true,
    servername: STRUCTURED_DOCUMENT_HOST,
    hostHeader: STRUCTURED_DOCUMENT_HOST,
    path: STRUCTURED_DOCUMENT_PATH,
    timeoutMs: 20_000,
  };
}

export function acceptStructuredCapture(input: {
  status: number;
  address: string;
  dials: readonly { address?: string; port?: number }[];
  auditPass: boolean;
  location?: string;
}): boolean {
  return input.status === 200 && input.auditPass && !input.location && input.dials.length === 1 &&
    input.dials[0]?.address === input.address && input.dials[0]?.port === 443;
}
