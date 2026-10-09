export const productHuntNineStageHtml=String.raw`<!doctype html><title>Isolated launch fixture</title><style>body{font:16px sans-serif}input,textarea,select,button{display:block;margin:8px}input[type=checkbox]{display:inline}</style><main id=stage></main><script>
window.created=0;window.trusted=false;window.visited=[];window.captured={};window.uploads=[];
const panes=[
 '<h1>My products</h1><p>Frozen Product draft</p><button onclick="render(1)">Continue editing</button>',
 '<h1>Main info</h1><label>Product name<input name="name" required></label><label>Website<input name="website" type="url" required></label><label>Tagline<input name="tagline" required></label><label>Product description<textarea name="description" required></textarea></label><label>First comment<textarea name="commentBody"></textarea></label><button onclick="capture();render(2)">Next step: Images and media</button>',
 '<h1>Images and media</h1><label>Logo<input name="thumbnailImageUuid" type="file" accept="image/png" required onchange="preview(this)"></label><label>Gallery<input name="media" type="file" accept="image/png" multiple required onchange="preview(this)"></label><button onclick="render(3)">Next step: Makers</button>',
 '<h1>Makers</h1><label><input type="checkbox" name="isMaker" id="isMaker">I worked on this product</label><label><input type="checkbox" name="soloMaker" id="soloMaker">Solo maker</label><button onclick="capture();render(4)">Next step: Company info</button>',
 '<h1>Company info</h1><label><input type="checkbox" name="bootstrapped" id="bootstrapped">Bootstrapped</label><label>Team size<select name="teamSize"><option value="1" selected>1</option></select></label><label>Crunchbase URL<input name="crunchbaseUrl" type="url"></label><button onclick="capture();render(5)">Next step: Shoutouts</button>',
 '<h1>Shoutouts</h1><label>Optional shoutout<textarea name="shoutoutOptional"></textarea></label><button onclick="capture();render(6)">Next step: Extras</button>',
 '<h1>Extras</h1><label>Pricing<select name="pricingType"><option value="">Choose</option><option value="free">Free</option></select></label><button onclick="capture();render(7)">Next step: Connect with investors</button>',
 '<h1>Investors</h1><button onclick="render(8)">Next step: Launch checklist</button>',
 '<h1>Launch checklist</h1><div role="progressbar" aria-valuenow="100">All steps complete</div><button id="create" onclick="window.trusted=event.isTrusted;window.created++;document.querySelector(\x27main\x27).innerHTML=\x27<h1>Frozen Product</h1><p>Draft created</p>\x27">Create draft</button>'
];
window.capture=()=>document.querySelectorAll('input,textarea,select').forEach(e=>window.captured[e.name]=e.type==='checkbox'?e.checked:e.value);
window.preview=async input=>{const files=await Promise.all([...input.files].map(async file=>({name:file.name,type:file.type,bytes:[...new Uint8Array(await file.arrayBuffer())]})));window.uploads.push({input:input.name,files});for(const file of input.files){const image=document.createElement('img');image.alt=input.name==='media'?'Media':'preview';image.width=30;image.height=30;image.src=URL.createObjectURL(file);input.parentElement.append(image);}};
window.render=index=>{window.visited.push(index);document.querySelector('main').innerHTML=panes[index];};render(0);
</script>`;
