/** MAINCIW: the main CI gate's receipt prefix (scheduler-main-ci-wiring.ts). Like FROZEN a collateral release, never counted. */
export const MAIN_CI_PAUSE = "main_ci_pause";
/** Only the sending stack may attest an updating claim whose update request has not left the process. */
export const MAIN_CI_UPDATE_NOT_SENT = `${MAIN_CI_PAUSE}：update-branch 未发出；`;
