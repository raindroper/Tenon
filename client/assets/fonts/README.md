# MiSans 字体声明与来源

**Tenon 使用 MiSans 字体。** MiSans 的权利人和许可方为小米科技有限责任公司（Xiaomi Inc.）；字体内原有的版权信息保持不变。

本目录仅供 Tenon 界面嵌入使用，不作为独立字体包分发或销售。使用和发行须遵守所附[官方许可协议](MiSans-LICENSE.pdf)；协议允许在作品或应用中使用，要求注明 MiSans、保留版权和许可，不允许改编字体字形或单独再分发字体软件。详情以官方协议原文为准。

## 获取与完整性

- 获取日期：2026-11-10。
- 官网：[MiSans](https://hyperos.mi.com/font/zh/)、[官方下载](https://hyperos.mi.com/font/zh/download/)、[嵌入使用说明](https://hyperos.mi.com/font/zh/faq/)。
- 字体定义来自官网自身使用的[官方 MiSans VF 简中与 Latin CSS](https://cdn-font.hyperos.mi.com/font/css?family=MiSans_VF:VF:Chinese_Simplify,Latin&display=swap)。
- 本目录保存该定义的全部 **56 份官方 WOFF2**，覆盖该官方简体中文与 Latin 集合；没有只截取界面示例文字，也没有自行子集化、合并、压缩或改写字体文件。
- 字体文件总大小为 **4,523,768 字节**；各文件为 8,504–109,788 字节。浏览器根据 `unicode-range` 及实际字符选择加载，首次加载量取决于页面文字，不在此估算。
- 原始官方 CSS 声明的可变字重范围为 **1–999**，`font-display: swap` 保持不变。`misans.css` 仅将 CSS family 别名设为 `MiSans`，并把字体 URL 换为本地相对路径，移除不需要的其他格式后备 URL。
- 每个字体文件的官方 URL、实际字节数及 SHA-256 均记录在 [misans-manifest.json](misans-manifest.json)。协议 PDF 亦记录原始 URL 和 SHA-256。

## 在应用中引用

`client/styles.css` 引入 `./assets/fonts/misans.css`，界面使用 `font-family: 'MiSans', ...`。字体文件由 Vite 作为普通本地资产处理，不向小米 CDN 发运行时请求。设置页面保留 MiSans 声明和许可链接，打包时该链接同时保留协议 PDF。

字体文件的内嵌版权信息、官方原始协议及来源清单均应随相关源码或应用发行保留。此字体许可不替代项目本身的许可。
