import {
    Context, CreateError as Err, Handler, HydroError, param, PRIV, Types, UserFacingError,
} from 'hydrooj';

export interface WikiDoc {
    path: string;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    owner: number;
}

export interface WikiTreeNode {
    title: string;
    path: string;
    href: string;
    hasDoc: boolean;
    active: boolean;
    expanded: boolean;
    children: WikiTreeNode[];
}

type WikiShallow = Pick<WikiDoc, 'path' | 'title'>;

let collection: any = null;

function normalizePath(p?: string | null): string {
    return (p || '')
        .split('/')
        .map((s) => s.trim())
        .filter((s) => !!s && s !== '.')
        .join('/');
}

function parentPath(p: string): string {
    const segs = p.split('/');
    segs.pop();
    return segs.join('/');
}

export function wikiUrl(path: string): string {
    const segs = normalizePath(path).split('/').filter((s) => !!s).map((i) => encodeURIComponent(i));
    return ['', 'wiki', ...segs].join('/');
}

export function wikiEditUrl(path: string): string {
    return `${wikiUrl(path)}/edit`;
}

const ReservedSegmentError = Err('ReservedSegmentError', UserFacingError, function (this: HydroError) {
    return 'Path segment "{0}" is reserved.';
});
const InvalidPathError = Err('InvalidPathError', UserFacingError, function (this: HydroError) {
    return 'Invalid wiki path.';
});
const PageExistError = Err('PageExistError', UserFacingError, function (this: HydroError) {
    return 'Page already exists at path "{0}".';
});
const HomeMoveError = Err('HomeMoveError', UserFacingError, function (this: HydroError) {
    return 'The home page cannot be moved.';
});
const DeleteHomeError = Err('DeleteHomeError', UserFacingError, function (this: HydroError) {
    return 'The home page cannot be removed.';
});

function validatePath(p: string) {
    if (!p) return;
    if (p.length > 200) throw new InvalidPathError();
    for (const seg of p.split('/')) {
        if (!seg || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('#')) {
            throw new InvalidPathError();
        }
        if (seg === 'edit') throw new ReservedSegmentError(seg);
    }
}

function buildTree(docs: WikiShallow[], current: string): WikiTreeNode[] {
    const byPath = new Map<string, WikiTreeNode>();
    const implicit = new Map<string, WikiTreeNode>();
    const roots: WikiTreeNode[] = [];
    const isPrefix = (prefix: string) => !!prefix && prefix !== current && (current === prefix || current.startsWith(`${prefix}/`));
    const make = (title: string, path: string, hasDoc: boolean): WikiTreeNode => ({
        title,
        path,
        href: hasDoc ? wikiUrl(path) : '',
        hasDoc,
        active: path === current,
        expanded: (!hasDoc && path === current) || isPrefix(path),
        children: [],
    });
    for (const doc of docs) {
        if (byPath.has(doc.path)) continue;
        byPath.set(doc.path, make(doc.title, doc.path, true));
    }
    const nodeOf = (p: string) => byPath.get(p) || implicit.get(p);
    const ensureAncestors = (p: string) => {
        if (!p) return;
        const pp = parentPath(p);
        if (!pp) return;
        if (!nodeOf(pp)) {
            const segs = pp.split('/');
            implicit.set(pp, make(segs[segs.length - 1] || pp, pp, false));
        }
        ensureAncestors(pp);
    };
    const attach = (node: WikiTreeNode) => {
        const pp = parentPath(node.path);
        if (!pp) { roots.push(node); return; }
        ensureAncestors(pp);
        const parent = nodeOf(pp);
        if (parent) parent.children.push(node);
        else roots.push(node);
    };
    for (const node of byPath.values()) attach(node);
    for (const node of implicit.values()) attach(node);
    return roots;
}

export class WikiModel {
    static init(db: any) {
        collection = db.collection('wiki');
    }

    static async ensureIndexes(db: any) {
        await db.ensureIndexes(collection, {
            key: { path: 1 },
            name: 'wiki_path_1',
            unique: true,
        });
    }

    static async add(path: string, title: string, content: string, owner: number, ip?: string) {
        const p = normalizePath(path);
        await collection.updateOne(
            { path: p },
            { $set: { title, content, owner, ip }, $setOnInsert: { updateAt: new Date(), views: 0 } },
            { upsert: true },
        );
    }

    static async get(path: string): Promise<WikiDoc | null> {
        return await collection.findOne({ path: normalizePath(path) });
    }

    static async update(path: string, title: string, content: string, ip?: string) {
        const p = normalizePath(path);
        await collection.updateOne({ path: p }, { $set: { title, content, updateAt: new Date(), ...(ip ? { ip } : {}) } });
    }

    static async incViews(path: string) {
        await collection.updateOne({ path: normalizePath(path) }, { $inc: { views: 1 } });
    }

    static async rename(from: string, to: string) {
        const f = normalizePath(from);
        const t = normalizePath(to);
        if (!f) return;
        const fEsc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const doc of await collection.find({ path: { $regex: `^${fEsc}(?:\\/.*)?$` } }).toArray()) {
            const rest = doc.path === f ? '' : doc.path.slice(f.length + 1);
            const newPath = rest ? (t ? `${t}/${rest}` : rest) : t;
            await collection.updateOne({ _id: doc._id }, { $set: { path: newPath } });
        }
    }

    static async remove(path: string) {
        const p = normalizePath(path);
        if (!p) return;
        const pEsc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await collection.deleteMany({ path: { $regex: `^${pEsc}(?:\\/.*)?$` } });
    }

    static async all(): Promise<WikiShallow[]> {
        return await collection.find({}, { projection: { path: 1, title: 1 } }).sort({ path: 1 }).toArray();
    }
}

class WikiMainHandler extends Handler {
    @param('path', Types.String, true)
    async get(domainId: string, path?: string) {
        const current = normalizePath(path);
        const [docs, wdoc] = await Promise.all([WikiModel.all(), WikiModel.get(current)]);
        if (wdoc) await WikiModel.incViews(current);
        const flat = docs.filter((d) => d.path !== '').slice().sort((a, b) => (a.path < b.path ? -1 : 1));
        const flatter: WikiShallow[] = [];
        for (const d of flat) {
            const segs = d.path.split('/');
            let prefix = '';
            for (let i = 0; i < segs.length - 1; i++) {
                prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
                if (!flatter.find((x) => x.path === prefix)) flatter.push({ path: prefix, title: segs[i] });
            }
            flatter.push(d);
        }
        const idx = flatter.findIndex((d) => d.path === current);
        const prev = idx > 0 ? flatter[idx - 1] : null;
        const next = idx >= 0 && idx < flatter.length - 1 ? flatter[idx + 1] : null;
        const crumbs: Array<{ title: string; href: string; active: boolean }> = [];
        if (current) {
            const segs = current.split('/');
            let prefix = '';
            for (let i = 0; i < segs.length; i++) {
                prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
                crumbs.push({
                    title: (docs.find((x) => x.path === prefix)?.title) || segs[i],
                    href: wikiUrl(prefix),
                    active: prefix === current,
                });
            }
        }
        this.response.template = 'wiki_main.html';
        this.response.body = {
            wdoc,
            tree: buildTree(docs, current),
            crumbs,
            prev: prev ? { title: prev.title, href: wikiUrl(prev.path) } : null,
            next: next ? { title: next.title, href: wikiUrl(next.path) } : null,
            editUrl: wikiEditUrl(current),
            wikiCount: docs.length,
        };
    }
}

class WikiEditHandler extends Handler {
    @param('path', Types.String, true)
    async get(domainId: string, path?: string) {
        const current = normalizePath(path);
        const wdoc = await WikiModel.get(current);
        this.response.template = 'wiki_edit.html';
        this.response.body = { wdoc, path: current, cancelUrl: wikiUrl(current) };
    }

    @param('path', Types.String, true)
    @param('oldpath', Types.String, true)
    async postDelete(domainId: string, path?: string, oldpath?: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await this.limitRate('wiki_write', 60, 30);
        const target = normalizePath(oldpath || path);
        if (!target) throw new DeleteHomeError();
        await WikiModel.remove(target);
        this.response.redirect = wikiUrl(parentPath(target));
    }

    @param('path', Types.String, true)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('oldpath', Types.String, true)
    async postSave(domainId: string, path?: string, title: string, content: string, oldpath?: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const p = normalizePath(path);
        validatePath(p);
        await this.limitRate('wiki_write', 60, 30);
        const old = normalizePath(oldpath);
        if (old && old !== p) {
            if (old === '' || p === '') throw new HomeMoveError();
            const existing = await WikiModel.get(p);
            if (existing) throw new PageExistError(p);
            await WikiModel.rename(old, p);
        }
        const existed = await WikiModel.get(p);
        if (existed) await WikiModel.update(p, title, content, this.request.ip);
        else await WikiModel.add(p, title, content, this.user._id, this.request.ip);
        this.response.redirect = wikiUrl(p);
    }
}

export async function apply(ctx: Context) {
    WikiModel.init(ctx.db);
    await WikiModel.ensureIndexes(ctx.db);

    ctx.Route('wiki_edit_home', '/wiki/edit', WikiEditHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('wiki_edit', '/wiki/*path/edit', WikiEditHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('wiki_home', '/wiki', WikiMainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('wiki_main', '/wiki/*path', WikiMainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'wiki_home', { prefix: 'wiki' }, PRIV.PRIV_USER_PROFILE);

    ctx.i18n.load('zh', {
        Wiki: '维基',
        wiki_home: '维基',
        wiki_edit_home: '编辑维基首页',
        wiki_edit: '编辑维基页面',
        'Category': '分类',
        Edit: '编辑',
        Delete: '删除',
        Save: '保存',
        Cancel: '取消',
        'New Page': '新建页面',
        'Create a Page': '新建页面',
        'Update a Page': '更新页面',
        'Edit Page': '编辑页面',
        Path: '路径',
        Title: '标题',
        Content: '内容',
        'This page does not exist.': '此页面不存在，点击右上角按钮创建。',
        'This wiki has no content yet.': '这个维基还没有内容，点击右上角按钮创建首页。',
        'Previous': '上一页',
        'Next': '下一页',
        'Last updated': '最后更新',
        Views: '浏览',
        'Path segment "{0}" is reserved.': '路径片段 "{0}" 是保留字。',
        'Invalid wiki path.': '无效的维基路径。',
        'Page already exists at path "{0}".': '路径 "{0}" 已存在页面。',
        'The home page cannot be moved.': '首页无法移动。',
        'The home page cannot be removed.': '首页无法删除。',
        'Use "/" to organize pages into a tree. The segment "edit" is reserved.': '使用 "/" 组织页面的层级结构，路径片段 "edit" 为保留字。',
        'Delete this page? All sub-pages will also be deleted.': '确定删除该页面吗？其所有子页面也会一并删除。',
        'On this page': '本页目录',
        Home: '首页',
        Docs: '文档',
        'Wiki Home': '首页',
        'Fold the catalog': '折叠目录',
        'Unfold the catalog': '展开目录',
    });
    ctx.i18n.load('zh_TW', {
        Wiki: '維基',
        wiki_home: '維基',
        wiki_edit_home: '編輯維基首頁',
        wiki_edit: '編輯維基頁面',
        Edit: '編輯',
        Delete: '刪除',
        Save: '儲存',
        Cancel: '取消',
        'New Page': '新建頁面',
        'Create a Page': '新建頁面',
        'Update a Page': '更新頁面',
        'Edit Page': '編輯頁面',
        Path: '路徑',
        Title: '標題',
        Content: '內容',
        'This page does not exist.': '此頁面不存在，點擊右上角按鈕建立。',
        'This wiki has no content yet.': '這個維基還沒有內容，點擊右上角按鈕建立首頁。',
        'Previous': '上一頁',
        'Next': '下一頁',
        'Last updated': '最後更新',
        Views: '瀏覽',
        'Path segment "{0}" is reserved.': '路徑片段 "{0}" 是保留字。',
        'Invalid wiki path.': '無效的維基路徑。',
        'Page already exists at path "{0}".': '路徑 "{0}" 已存在頁面。',
        'The home page cannot be moved.': '首頁無法移動。',
        'The home page cannot be removed.': '首頁無法刪除。',
        'Use "/" to organize pages into a tree. The segment "edit" is reserved.': '使用 "/" 組織頁面的階層結構，路徑片段 "edit" 為保留字。',
        'Delete this page? All sub-pages will also be deleted.': '確定刪除該頁面嗎？其所有子頁面也會一併刪除。',
        'On this page': '本頁目錄',
        Home: '首頁',
        Docs: '文件',
        'Wiki Home': '首頁',
        'Fold the catalog': '摺疊目錄',
        'Unfold the catalog': '展開目錄',
    });
    ctx.i18n.load('en', {
        Wiki: 'Wiki',
        wiki_home: 'Wiki',
        'Edit Page': 'Edit Page',
        Path: 'Path',
        Title: 'Title',
        Content: 'Content',
        'This page does not exist.': 'This page does not exist yet.',
        'This wiki has no content yet.': 'This wiki has no content yet.',
        Previous: 'Previous',
        Next: 'Next',
        Views: 'Views',
        'On this page': 'On this page',
        Home: 'Home',
        Docs: 'Docs',
        'Wiki Home': 'Wiki Home',
        'The home page cannot be moved.': 'The home page cannot be moved.',
        'The home page cannot be removed.': 'The home page cannot be removed.',
        'Use "/" to organize pages into a tree. The segment "edit" is reserved.': 'Use "/" to organize pages into a tree. The segment "edit" is reserved.',
        'Delete this page? All sub-pages will also be deleted.': 'Delete this page? All sub-pages will also be deleted.',
    });
}