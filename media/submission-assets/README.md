# 外链提交媒体库

这里保存各 Profile 的本地上传兜底素材。每个项目目录包含：

- `logo.png`：优先用于只接受 PNG/JPG 的 Logo 上传框；原项目只有 SVG 时同时保留 `logo.svg`。
- `01-*.png` 至 `04-*.png`：从对应线上公开功能页以 1440×900 视口截取的当前界面。

Google Sheet 的标准媒体字段继续填写可公开下载的图片直链；`Local media folder`、`Local LOGO`、`Local Screenshot 1–4` 保存本机相对路径，供 Cursor/Computer Use 遇到文件上传框时选择。不要把本地路径当作公开 URL 填进普通 URL 输入框。

截图页面与用途见 [`manifest.json`](manifest.json)。
