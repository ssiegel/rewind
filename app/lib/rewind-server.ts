/**
 * Server-side singleton for the Rewind instance.
 * Used by API routes to access session data.
 */
import { createRewind, type Rewind } from "../../src/index";

let _instance: Rewind | null = null;

export function getRewind(): Rewind {
  if (!_instance) {
    _instance = createRewind();
  }
  return _instance;
}
