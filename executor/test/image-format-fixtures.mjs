const svg='<?xml version="1.0" encoding="UTF-8"?>\n<!-- 原标志 -->\n<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="#336699"/></svg>';
export const imageFormatFixtures=[
 {mime:'image/gif',name:'original-logo.gif',bytes:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')},
 {mime:'image/svg+xml',name:'original-logo.svg',bytes:Buffer.from(svg)},
];
for(const image of imageFormatFixtures)image.dataUrl='data:'+image.mime+';base64,'+image.bytes.toString('base64');
