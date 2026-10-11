import { defineChannel, GET, POST } from 'eve/channels';
import { handleCloud } from '../../cloud/runtime.ts';
// Additive surface. Does not call an Eve model, existing browser tools or external sites.
export default defineChannel({routes:[
 ...['/cloud','/cloud.js','/cloud.css','/v1/cloud'].map(path=>GET(path,handleCloud)),
 ...['/v1/cloud/jobs','/v1/cloud/schedules','/v1/cloud/schedules/disable','/v1/cloud/controls','/v1/cloud/approval','/v1/cloud/cancel'].map(path=>POST(path,handleCloud)),
]});
