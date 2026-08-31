const BRIDGE_REQUEST_PATH = /^\/(?:api(?:\/|$)|media\/|thumbnail\/|post-media\/|post-download\/)/;

export function isBridgeRequestPath(pathname) {
  return BRIDGE_REQUEST_PATH.test(String(pathname || ""));
}
