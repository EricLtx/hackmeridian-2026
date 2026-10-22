// French dictionary: one file per source module, merged here.
import common from "./common.js";
import page from "./page.js";
import main from "./main.js";
import terminal from "./terminal.js";
import command from "./command.js";
import blotter from "./blotter.js";
import guide from "./guide.js";
import timeline from "./timeline.js";
import errors from "./errors.js";
import wallet from "./wallet.js";
import chain from "./chain.js";
import history from "./history.js";
import terms from "./terms.js";
import deployment from "./deployment.js";
import frame from "./frame.js";
import roles from "./roles.js";
import operate from "./operate.js";

export default { ...common, ...page, ...main, ...terminal, ...command, ...blotter, ...guide, ...timeline, ...errors, ...wallet, ...chain, ...history, ...terms, ...deployment, ...frame, ...roles, ...operate };
