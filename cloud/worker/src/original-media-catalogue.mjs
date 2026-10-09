// Recovery audit only: query the original PostgreSQL index, never create a
// workspace or change PostgreSQL, D1, R2 or current product associations.
export async function originalMediaCatalogue(sql, workspace) {
  const assets = await sql`
    select asset_id, profile_id, media_kind, media_index, file_name,
           content_type, byte_length, sha256, created_at, updated_at
    from externallink_media_assets where workspace_id = ${workspace}
    order by file_name
  `;
  return {ok:true, source:'original-neon-media-index', workspaceId:workspace,
    readOnly:true, assets};
}

export async function originalMediaCatalogueResponse(sqlFactory, workspace) {
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  try {
    return new Response(JSON.stringify(await originalMediaCatalogue(sqlFactory(),workspace)),{headers});
  } catch {
    // Provider errors may contain connection information. Keep it private and
    // leave the missing source explicit instead of substituting the R2 index.
    return new Response(JSON.stringify({ok:false,source:'original-neon-media-index',
      readOnly:true,code:'ORIGINAL_MEDIA_SOURCE_UNAVAILABLE',
      error:'原数据库媒体目录暂不可读取；未使用当前目录替代'}),{status:503,headers});
  }
}
