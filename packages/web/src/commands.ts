/**
 * The commands the dashboard suggests. Spectra is run either from a checkout (`npm start`) or as
 * the installed `spectra` command; the hub marks the page when it is the installed one.
 */
const installed = typeof document !== "undefined" && document.documentElement.dataset.install === "command";

export const CMD = installed
  ? {
      start: "spectra start",
      hooks: "spectra init /path/to/project",
      demo: "spectra demo",
      navigator: "spectra navigator",
      verify: "spectra verify",
    }
  : {
      start: "npm start",
      hooks: "npm run hooks:install -- /path/to/project",
      demo: "npm run demo",
      navigator: "npm run validator",
      verify: "npm run verify --",
    };
