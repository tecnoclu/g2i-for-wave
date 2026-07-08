import { contextBridge } from 'electron';

// Custom APIs for renderer
const api = {
  // We don't expose any sensitive environment variables here.
  // The frontend will make HTTP requests directly to our local proxy (e.g., http://localhost:3001).
  getProxyUrl: () => 'http://localhost:3001'
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api;
}
