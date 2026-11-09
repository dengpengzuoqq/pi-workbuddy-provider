// index.ts — 仓库根入口：仅转发 extensions/index.ts 的工厂。
// pi 对本地路径安装的扩展按"入口文件路径尾段"显示名称（尾段 index.ts 会被剥掉），
// 入口放根目录才能在 Extensions 列表里显示为包名 pi-workbuddy-plugin，而不是子目录名。
export { default } from "./extensions/index.ts";
