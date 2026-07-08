/// <reference types="vite/client" />

interface Window {
  api: {
    getProxyUrl: () => string;
  };
}
