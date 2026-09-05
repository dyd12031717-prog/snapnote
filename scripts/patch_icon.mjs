// 用 resedit 纯 JS 替换 win-unpacked/SnapNote.exe 的图标组（替代 wine+rcedit）
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const ROOT = '/home/z/my-project/snapnote';
const EXE = path.join(ROOT, 'release/win-unpacked/SnapNote.exe');
const ICO = path.join(ROOT, 'assets/icon.ico');

const data = fs.readFileSync(EXE);
const exe = NtExecutable.from(data);
const res = NtExecutableResource.from(exe);

// 找到现有图标组（RT_GROUP_ICON = 14）
const groups = res.entries.filter(e => e.type === 14);
if (groups.length === 0) throw new Error('未找到图标组资源');
const groupId = groups[0].id;
console.log('icon group id =', groupId, '| groups =', groups.length);

const iconFile = Data.IconFile.from(fs.readFileSync(ICO));
const iconItems = iconFile.icons.map((i) => i.data); // 换成 IconItem/RawIconItem 实例
Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, groups[0].lang, iconItems);
console.log('icons embedded:', iconItems.length, 'sizes');

// 附加版本信息（显示名称/版本号）— VersionInfo 位于 Resource 命名空间
const vi = Resource.VersionInfo.createEmpty();
vi.setFileVersion('1.0.0.0');
vi.setProductVersion('1.0.0.0');
vi.setStringValues({
  lang: 0x0409, // en-US
  key: {
    FileDescription: '磁吸便签 SnapNote',
    FileVersion: '1.0.0.0',
    ProductName: 'SnapNote',
    ProductVersion: '1.0.0.0',
    OriginalFilename: 'SnapNote.exe',
    LegalCopyright: 'MIT License',
  },
});
vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
fs.writeFileSync(EXE, Buffer.from(exe.generate()));
console.log('PATCHED', EXE, fs.statSync(EXE).size, 'bytes');
