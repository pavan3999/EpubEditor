/* Android/browser EPUB merger for EpubEditor.
 *
 * First selected EPUB = base.
 * Remaining EPUBs = appended in order.
 *
 * Every input EPUB is stored in its own numbered volume directory:
 * 1/, 2/, 3/, ... so relative links inside each volume remain valid.
 */
"use strict";

class EpubMerger {
    static async merge(files, metadata = null) {
        if (!files || files.length < 2) {
            throw new Error("Select at least two EPUB files.");
        }

        const epubs = [];
        for (const file of files) {
            epubs.push(await JSZip.loadAsync(file));
        }

        const base = epubs[0];
        const baseInfo = await this.readEpubInfo(base);

        /*
         * Final package layout:
         *
         *   OEBPS/
         *     1/   <- first/input EPUB
         *     2/   <- second/input EPUB
         *     3/   <- third/input EPUB
         *     ...
         *
         * The root OPF/NCX/nav remain package-level documents.
         * Each volume keeps its original internal directory structure
         * relative to its OPF directory.
         */

        const volumeInfos = [];

        // Volume 1: move the base EPUB's content under 1/.
        await this.moveVolumeContent(base, baseInfo, "1/");
        volumeInfos.push({
            info: baseInfo,
            prefix: "1/",
            nameMap: baseInfo.nameMap
        });

        // Volumes 2, 3, 4, ...: copy each source EPUB under its number.
        for (let i = 1; i < epubs.length; i++) {
            const srcZip = epubs[i];
            const srcInfo = await this.readEpubInfo(srcZip);
            const prefix = String(i + 1) + "/";
            const nameMap = await this.moveVolumeContent(
                srcZip,
                srcInfo,
                prefix,
                base
            );

            volumeInfos.push({
                info: srcInfo,
                prefix,
                nameMap
            });
        }

        const baseOpfDir = this.dirname(baseInfo.opfName);
        const baseManifest = baseInfo.opfDom.querySelector("manifest");
        const baseSpine = baseInfo.opfDom.querySelector("spine");

        if (!baseManifest || !baseSpine) {
            throw new Error("Invalid EPUB: OPF is missing manifest or spine.");
        }

        // Volume 1's manifest hrefs now point into 1/.
        this.rewriteBaseManifest(baseInfo.opfDom, baseInfo);

        // Add manifest and spine entries for volumes 2+.
        for (let i = 1; i < volumeInfos.length; i++) {
            const { info, nameMap } = volumeInfos[i];
            const idMap = new Map();

            for (const item of Array.from(
                info.opfDom.querySelectorAll("manifest > item")
            )) {
                const oldId = item.getAttribute("id");
                const href = item.getAttribute("href");

                if (!oldId || !href) {
                    continue;
                }

                const sourcePath = this.resolvePath(
                    this.dirname(info.opfName),
                    href
                );
                const mappedPath = nameMap.get(sourcePath);

                if (!mappedPath) {
                    continue;
                }

                const newId = this.uniqueManifestId(
                    oldId,
                    i + 1,
                    baseManifest
                );

                idMap.set(oldId, newId);

                const newItem = baseInfo.opfDom.createElementNS(
                    "http://www.idpf.org/2007/opf",
                    "item"
                );

                for (const attr of Array.from(item.attributes)) {
                    if (attr.name === "id") {
                        newItem.setAttribute("id", newId);
                    } else if (attr.name === "href") {
                        newItem.setAttribute(
                            "href",
                            this.relativePath(
                                baseOpfDir,
                                mappedPath
                            )
                        );
                    } else {
                        newItem.setAttribute(attr.name, attr.value);
                    }
                }

                baseManifest.appendChild(newItem);
            }

            for (const ref of Array.from(
                info.opfDom.querySelectorAll("spine > itemref")
            )) {
                const oldId = ref.getAttribute("idref");
                const newId = idMap.get(oldId);

                if (!newId) {
                    continue;
                }

                const newRef = baseInfo.opfDom.createElementNS(
                    "http://www.idpf.org/2007/opf",
                    "itemref"
                );

                for (const attr of Array.from(ref.attributes)) {
                    if (attr.name === "idref") {
                        newRef.setAttribute("idref", newId);
                    } else {
                        newRef.setAttribute(attr.name, attr.value);
                    }
                }

                baseSpine.appendChild(newRef);
            }
        }

        // EPUB 2 NCX.
        if (baseInfo.ncxDom && baseInfo.ncxName) {
            const baseNavMap = baseInfo.ncxDom.querySelector("navMap");

            if (baseNavMap) {
                const navVolumes = [];

                for (const volume of volumeInfos) {
                    if (!volume.info.ncxDom) {
                        continue;
                    }

                    const srcNavMap =
                        volume.info.ncxDom.querySelector("navMap");

                    if (!srcNavMap) {
                        continue;
                    }

                    navVolumes.push({
                        volume,
                        srcNavMap
                    });
                }

                this.mergeNcxNavMaps(
                    baseInfo.ncxDom,
                    baseInfo.ncxName,
                    navVolumes
                );
            }
        }

        // EPUB 3 / WebToEpub XHTML navigation.
        if (baseInfo.navDom && baseInfo.navName) {
            const baseToc = this.findTocNav(baseInfo.navDom);

            if (baseToc) {
                // Rewrite Volume 1's existing navigation into 1/.
                this.rewriteHrefAttributes(
                    baseToc,
                    baseInfo.navName,
                    baseInfo.navName,
                    baseInfo.nameMap
                );

                // Append Volumes 2+.
                for (let i = 1; i < volumeInfos.length; i++) {
                    const { info, nameMap } = volumeInfos[i];

                    if (!info.navDom) {
                        continue;
                    }

                    const srcToc = this.findTocNav(info.navDom);

                    if (!srcToc) {
                        continue;
                    }

                    for (const child of Array.from(srcToc.children)) {
                        const clone = child.cloneNode(true);

                        this.rewriteHrefAttributes(
                            clone,
                            info.navName,
                            baseInfo.navName,
                            nameMap
                        );

                        baseToc.appendChild(
                            baseInfo.navDom.importNode(clone, true)
                        );
                    }
                }
            }
        }


        // Apply optional final metadata to the merged package.
        if (metadata && (
            String(metadata.title ?? "").trim() ||
            String(metadata.author ?? "").trim() ||
            String(metadata.subject ?? "").trim() ||
            String(metadata.description ?? "").trim()
        )) {
            this.applyMetadata(baseInfo.opfDom, metadata, true);
        }

        // Rewrite EPUB 2 guide/reference hrefs, if present.
        this.rewriteOpfReferences(
            baseInfo.opfDom,
            baseInfo
        );

        // Save modified structural files. Preserve the base EPUB's original
        // XML declaration and <package ...> opening byte-for-byte.
        let finalOpfText = this.serializeXml(baseInfo.opfDom);
        finalOpfText = this.restoreOriginalOpfHeader(
            finalOpfText,
            baseInfo.opfSource
        );
        base.file(
            baseInfo.opfName,
            finalOpfText,
            this.zipOptions(base.file(baseInfo.opfName))
        );

        if (baseInfo.ncxDom && baseInfo.ncxName) {
            base.file(
                baseInfo.ncxName,
                this.serializeXml(baseInfo.ncxDom),
                this.zipOptions(base.file(baseInfo.ncxName))
            );
        }

        if (baseInfo.navDom && baseInfo.navName) {
            base.file(
                baseInfo.navName,
                this.serializeXml(baseInfo.navDom),
                this.zipOptions(base.file(baseInfo.navName))
            );
        }

        const blob = await base.generateAsync({
            type: "blob",
            mimeType: "application/epub+zip"
        });

        return {
            blob,
            chapterCount:
                baseInfo.opfDom.querySelectorAll("spine > itemref").length,
            appendedCount: epubs.length - 1
        };
    }


    static applyMetadata(opfDom, metadata, preserveBlank = false) {
        const metadataEl = opfDom.querySelector("metadata");
        if (!metadataEl) {
            throw new Error("EPUB OPF has no metadata element.");
        }

        const dcNs = "http://purl.org/dc/elements/1.1/";
        const getValue = key => String(metadata?.[key] ?? "");

        const titleValue = getValue("title").trim();
        const authorValue = getValue("author");
        const subjectValue = getValue("subject");
        const descriptionValue = getValue("description");

        let titleEl = metadataEl.querySelector("dc\\:title");
        if (!titleEl) {
            titleEl = opfDom.createElementNS(dcNs, "dc:title");
            metadataEl.insertBefore(titleEl, metadataEl.firstChild);
        }
        if (!preserveBlank || titleValue) {
            titleEl.textContent = titleValue;
        }

        if (!preserveBlank || authorValue.trim()) {
            const existingCreators = Array.from(metadataEl.querySelectorAll("dc\\:creator"));
            const authorValues = authorValue
                .split(",")
                .map(s => s.trim())
                .filter(Boolean);
            for (const el of existingCreators) {
                el.remove();
            }
            for (let i = 0; i < authorValues.length; i++) {
                const el = opfDom.createElementNS(dcNs, "dc:creator");
                const old = existingCreators[i];
                if (old) {
                    for (const attr of Array.from(old.attributes || [])) {
                        el.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
                    }
                }
                el.textContent = authorValues[i];
                metadataEl.appendChild(el);
            }
        }

        if (!preserveBlank || subjectValue.trim()) {
            for (const el of Array.from(metadataEl.querySelectorAll("dc\\:subject"))) {
                el.remove();
            }
            for (const subject of subjectValue.split(",").map(s => s.trim()).filter(Boolean)) {
                const el = opfDom.createElementNS(dcNs, "dc:subject");
                el.textContent = subject;
                metadataEl.appendChild(el);
            }
        }

        if (!preserveBlank || descriptionValue.trim()) {
            let descriptionEl = metadataEl.querySelector("dc\\:description");
            if (!descriptionEl) {
                descriptionEl = opfDom.createElementNS(dcNs, "dc:description");
                const creator = metadataEl.querySelector("dc\\:creator");
                if (creator) metadataEl.insertBefore(descriptionEl, creator);
                else metadataEl.appendChild(descriptionEl);
            }

            if (descriptionValue.trim()) {
                const parts = descriptionValue
                    .split(/\n\s*\n/)
                    .map(p => p.trim())
                    .filter(Boolean);

                descriptionEl.textContent = parts
                    .map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
                    .join("\n");
            } else {
                descriptionEl.textContent = "";
            }
        }
    }

    static async moveVolumeContent(zip, info, prefix, destinationZip) {
        const sourceRoot = this.dirname(info.opfName);
        const nameMap = new Map();

        for (const name of Object.keys(zip.files)) {
            const entry = zip.files[name];

            if (
                entry.dir ||
                name === "mimetype" ||
                name === "META-INF/container.xml" ||
                name === info.opfName ||
                name === info.ncxName ||
                name === info.navName
            ) {
                continue;
            }

            const relative = this.relativeFromRoot(sourceRoot, name);

            // EPUB content should be under the OPF directory. Files outside
            // that directory are left alone rather than producing unsafe
            // paths such as 1/../...
            if (relative === null) {
                continue;
            }

            const newName = prefix + relative;
            nameMap.set(name, newName);

            const data = await entry.async("uint8array");

            if (destinationZip) {
                destinationZip.file(
                    newName,
                    data,
                    this.zipOptions(entry)
                );
            } else {
                zip.file(newName, data, this.zipOptions(entry));

                if (newName !== name) {
                    zip.remove(name);
                }
            }
        }

        info.nameMap = nameMap;
        return nameMap;
    }

    static relativeFromRoot(root, target) {
        const normalizedRoot = root ? root + "/" : "";

        if (normalizedRoot && target.startsWith(normalizedRoot)) {
            return target.substring(normalizedRoot.length);
        }

        if (!root) {
            return target;
        }

        return null;
    }

    static rewriteBaseManifest(opfDom, info) {
        const manifest = opfDom.querySelector("manifest");

        if (!manifest) {
            return;
        }

        const nameMap = info.nameMap || new Map();

        for (const item of Array.from(manifest.querySelectorAll("item"))) {
            const href = item.getAttribute("href");

            if (!href) {
                continue;
            }

            const hash = href.indexOf("#");
            const path = hash >= 0
                ? href.substring(0, hash)
                : href;
            const fragment = hash >= 0
                ? href.substring(hash)
                : "";

            const sourcePath = this.resolvePath(
                this.dirname(info.opfName),
                path
            );

            const mappedPath = nameMap.get(sourcePath);

            if (mappedPath) {
                item.setAttribute(
                    "href",
                    this.relativePath(
                        this.dirname(info.opfName),
                        mappedPath
                    ) + fragment
                );
            }
        }
    }

    static uniqueManifestId(oldId, volumeNumber, manifest) {
        let newId = oldId;
        let suffix = 1;

        const exists = id =>
            Array.from(manifest.querySelectorAll("item")).some(
                item => item.getAttribute("id") === id
            );

        if (!exists(newId)) {
            return newId;
        }

        do {
            newId =
                oldId +
                "_v" +
                volumeNumber +
                "_" +
                suffix++;
        } while (exists(newId));

        return newId;
    }

    static mergeNcxNavMaps(ncxDom, baseNcxName, navVolumes) {
        const navMap = ncxDom.querySelector("navMap");

        if (!navMap) {
            return;
        }

        // Rewrite Volume 1's existing navigation into 1/.
        const firstVolume = navVolumes.find(
            entry => entry.volume.prefix === "1/"
        );

        if (firstVolume) {
            this.rewriteNcxVolumeEntries(
                navMap,
                firstVolume.volume,
                baseNcxName
            );
        }

        // Append Volumes 2+.
        for (const entry of navVolumes) {
            if (entry.volume.prefix === "1/") {
                continue;
            }

            const { volume, srcNavMap } = entry;

            for (const navPoint of Array.from(srcNavMap.children)) {
                if (navPoint.localName !== "navPoint") {
                    continue;
                }

                const clone = navPoint.cloneNode(true);

                this.rewriteNcxVolumeEntries(
                    clone,
                    volume,
                    baseNcxName
                );

                navMap.appendChild(
                    ncxDom.importNode(clone, true)
                );
            }
        }

        // EPUB 2 requires entries that refer to the same target to use
        // the same playOrder. Normalize the complete merged navMap after
        // all volume paths have been rewritten.
        this.normalizeNcxPlayOrders(navMap);
        this.makeNcxIdsUnique(navMap);
    }

    static rewriteNcxVolumeEntries(node, volume, baseNcxName) {
        for (const content of Array.from(
            node.querySelectorAll("content")
        )) {
            const src = content.getAttribute("src");

            if (!src) {
                continue;
            }

            const hash = src.indexOf("#");
            const path = hash >= 0
                ? src.substring(0, hash)
                : src;
            const fragment = hash >= 0
                ? src.substring(hash)
                : "";

            const sourcePath = this.resolvePath(
                this.dirname(volume.info.ncxName),
                path
            );

            const mappedPath = volume.nameMap.get(sourcePath);

            if (mappedPath) {
                content.setAttribute(
                    "src",
                    this.relativePath(
                        this.dirname(baseNcxName),
                        mappedPath
                    ) + fragment
                );
            }
        }
    }

    static normalizeNcxPlayOrders(navMap) {
        const targetOrders = new Map();
        let nextOrder = 1;

        const points = Array.from(
            navMap.querySelectorAll(
                "navPoint, navTarget, pageTarget"
            )
        );

        for (const point of points) {
            if (!point.hasAttribute("playOrder")) {
                continue;
            }

            const content = Array.from(point.children || [])
                .find(child => String(child.localName || child.tagName).toLowerCase() === "content");
            const src = content
                ? content.getAttribute("src")
                : null;

            if (!src) {
                point.setAttribute(
                    "playOrder",
                    String(nextOrder++)
                );
                continue;
            }

            const target = this.normalizeNcxTarget(src);

            if (!targetOrders.has(target)) {
                targetOrders.set(target, nextOrder++);
            }

            point.setAttribute(
                "playOrder",
                String(targetOrders.get(target))
            );
        }
    }

    static normalizeNcxTarget(src) {
        const hash = src.indexOf("#");
        const path = hash >= 0
            ? src.substring(0, hash)
            : src;
        const fragment = hash >= 0
            ? src.substring(hash)
            : "";

        return this.resolvePath("", path) + fragment;
    }

    static makeNcxIdsUnique(navMap) {
        const used = new Set();

        const points = [
            ...Array.from(navMap.querySelectorAll("navPoint")),
            ...Array.from(navMap.querySelectorAll("navTarget")),
            ...Array.from(navMap.querySelectorAll("pageTarget"))
        ];

        for (const point of points) {
            const id = point.getAttribute("id");

            if (!id) {
                continue;
            }

            let candidate = id;
            let suffix = 1;

            while (used.has(candidate)) {
                candidate = id + "_m" + suffix++;
            }

            used.add(candidate);
            point.setAttribute("id", candidate);
        }
    }

    static rewriteOpfReferences(opfDom, info) {
        const guide = opfDom.querySelector("guide");

        if (!guide) {
            return;
        }

        const nameMap = info.nameMap || new Map();

        for (const reference of Array.from(
            guide.querySelectorAll("reference")
        )) {
            const href = reference.getAttribute("href");

            if (!href) {
                continue;
            }

            const hash = href.indexOf("#");
            const path = hash >= 0
                ? href.substring(0, hash)
                : href;
            const fragment = hash >= 0
                ? href.substring(hash)
                : "";

            const sourcePath = this.resolvePath(
                this.dirname(info.opfName),
                path
            );

            const mapped = nameMap.get(sourcePath);

            if (mapped) {
                reference.setAttribute(
                    "href",
                    this.relativePath(
                        this.dirname(info.opfName),
                        mapped
                    ) + fragment
                );
            }
        }
    }

    static async readEpubInfo(zip) {
        const container = await this.readXml(zip, "META-INF/container.xml");
        const rootfile = container.querySelector("rootfile");

        if (!rootfile) {
            throw new Error("Invalid EPUB: container.xml has no rootfile.");
        }

        const opfName = rootfile.getAttribute("full-path");
        const opfFile = zip.file(opfName);
        if (!opfFile) {
            throw new Error("EPUB is missing: " + opfName);
        }
        const opfSource = await opfFile.async("text");
        const opfDom = new DOMParser().parseFromString(opfSource, "text/html");
        const manifest = opfDom.querySelector("manifest");

        if (!manifest) {
            throw new Error("Invalid EPUB: OPF has no manifest.");
        }

        const items = Array.from(manifest.querySelectorAll("item"));

        const ncxItem = items.find(
            item =>
                item.getAttribute("media-type") ===
                "application/x-dtbncx+xml"
        );

        const navItem = items.find(item =>
            /\bnav\b/i.test(item.getAttribute("properties") || "")
        );

        const opfDir = this.dirname(opfName);

        const ncxName = ncxItem
            ? this.resolvePath(opfDir, ncxItem.getAttribute("href"))
            : null;

        const navName = navItem
            ? this.resolvePath(opfDir, navItem.getAttribute("href"))
            : null;

        const ncxDom =
            ncxName && zip.file(ncxName)
                ? await this.readXml(zip, ncxName)
                : null;

        const navDom =
            navName && zip.file(navName)
                ? await this.readXml(zip, navName)
                : null;

        return {
            opfName,
            opfSource,
            opfDom,
            ncxName,
            ncxDom,
            navName,
            navDom
        };
    }

    static async readXml(zip, name) {
        const file = zip.file(name);

        if (!file) {
            throw new Error("EPUB is missing: " + name);
        }

        const text = await file.async("text");
        const dom = new DOMParser().parseFromString(
            text,
            /\.opf$/i.test(name) ? "text/html" : "application/xml"
        );

        if (dom.querySelector("parsererror") || !dom.documentElement) {
            throw new Error("Invalid XML in EPUB: " + name);
        }

        if (/\.opf$/i.test(name) && !dom.querySelector("package")) {
            throw new Error("Invalid EPUB OPF package: " + name);
        }

        return dom;
    }

    static rewriteNcxNode(node, srcNcxName, baseNcxName, nameMap) {
        for (const content of Array.from(
            node.querySelectorAll("content")
        )) {
            const src = content.getAttribute("src");

            if (!src) {
                continue;
            }

            const hash = src.indexOf("#");
            const path = hash >= 0 ? src.substring(0, hash) : src;
            const fragment = hash >= 0 ? src.substring(hash) : "";

            const sourcePath = this.resolvePath(
                this.dirname(srcNcxName),
                path
            );

            const mappedPath = nameMap.get(sourcePath);

            if (mappedPath) {
                content.setAttribute(
                    "src",
                    this.relativePath(
                        this.dirname(baseNcxName),
                        mappedPath
                    ) + fragment
                );
            }
        }
    }

    static rewriteHrefAttributes(node, srcName, baseName, nameMap) {
        const elements = [
            node,
            ...Array.from(node.querySelectorAll("*"))
        ];

        for (const element of elements) {
            const href = element.getAttribute &&
                element.getAttribute("href");

            if (!href ||
                href.startsWith("#") ||
                /^[a-z][a-z0-9+.-]*:/i.test(href)) {
                continue;
            }

            const hash = href.indexOf("#");
            const path = hash >= 0 ? href.substring(0, hash) : href;
            const fragment = hash >= 0 ? href.substring(hash) : "";

            const sourcePath = this.resolvePath(
                this.dirname(srcName),
                path
            );

            const mappedPath = nameMap.get(sourcePath);

            if (mappedPath) {
                element.setAttribute(
                    "href",
                    this.relativePath(
                        this.dirname(baseName),
                        mappedPath
                    ) + fragment
                );
            }
        }
    }

    static findTocNav(dom) {
        return (
            Array.from(dom.querySelectorAll("nav")).find(
                nav =>
                    /\btoc\b/i.test(
                        nav.getAttribute("epub:type") ||
                        nav.getAttribute("type") ||
                        ""
                    )
            ) ||
            dom.querySelector("nav")
        );
    }

    static maxPlayOrder(navMap) {
        let max = 0;

        for (const point of Array.from(
            navMap.querySelectorAll("navPoint")
        )) {
            max = Math.max(
                max,
                parseInt(point.getAttribute("playOrder") || "0", 10) || 0
            );
        }

        return max;
    }

    static zipOptions(file) {
        const options = {};

        if (file && file.date) {
            options.date = file.date;
        }

        try {
            if (
                file &&
                file.options &&
                file.options.compression === "DEFLATE"
            ) {
                options.compression = "DEFLATE";
            }
        } catch (_) {}

        return options;
    }

    static dirname(path) {
        const index = path.lastIndexOf("/");

        return index < 0
            ? ""
            : path.substring(0, index);
    }

    static resolvePath(base, ref) {
        const parts =
            (base ? base + "/" : "") + (ref || "");

        const result = [];

        for (const part of parts.split("/")) {
            if (!part || part === ".") {
                continue;
            }

            if (part === "..") {
                result.pop();
            } else {
                result.push(part);
            }
        }

        return result.join("/");
    }

    static relativePath(fromDir, target) {
        const from = fromDir ? fromDir.split("/") : [];
        const to = target.split("/");

        while (
            from.length &&
            to.length &&
            from[0] === to[0]
        ) {
            from.shift();
            to.shift();
        }

        return "../".repeat(from.length) + to.join("/");
    }

    static restoreOriginalOpfHeader(serialized, original) {
        if (!original) return serialized;

        const originalMatch = String(original).match(/^[\s\S]*?<package\b[^>]*>/i);
        const serializedMatch = String(serialized).match(/^[\s\S]*?<package\b[^>]*>/i);

        if (!originalMatch || !serializedMatch) {
            return serialized;
        }

        return originalMatch[0] + String(serialized).slice(serializedMatch[0].length);
    }

    static serializeXml(dom) {
        let node = dom;
        const isHtmlWrapper = dom && dom.documentElement &&
            String(dom.documentElement.localName).toLowerCase() === "html";

        if (isHtmlWrapper) {
            node = dom.querySelector("package") || dom;
        }

        let text = new XMLSerializer().serializeToString(node);

        if (node && String(node.localName).toLowerCase() === "package") {
            // HTML parsing preserves the source OPF namespace attribute while
            // assigning the XHTML namespace to the <package> element itself.
            // Normalize the serialized root to one OPF default namespace.
            text = text.replace(
                /^<!--\?xml\s+version=['\"]1\.0['\"](?:\s+encoding=['\"][^'\"]+['\"])?\?-->/i,
                '<?xml version="1.0" encoding="UTF-8"?>'
            );
            text = text.replace(
                /<package\b([^>]*)>/i,
                (match, attrs) => {
                    attrs = attrs.replace(
                        /\s+xmlns\s*=\s*(['\"])[^'\"]*\1/gi,
                        ''
                    );
                    return '<package xmlns="http://www.idpf.org/2007/opf"' + attrs + '>';
                }
            );
        }


        // Normalize OPF 2 empty-element containers. Some source EPUBs use
        // HTML-style <item>/<itemref> start tags; XML requires these entries
        // to be empty elements inside manifest/spine.
        text = text.replace(
            /<manifest\b([^>]*)>([\s\S]*?)<\/manifest>/i,
            (match, attrs, inner) => {
                const items = [];
                inner.replace(/<item\b([^>]*)\/?>(?:<\/item>)?/gi, (m, itemAttrs) => {
                    itemAttrs = itemAttrs.replace(/\s*\/$/, '');
                    items.push('    <item' + itemAttrs + '/>');
                    return m;
                });
                return '<manifest' + attrs + '>\n' + items.join('\n') + '\n  </manifest>';
            }
        );

        text = text.replace(
            /<spine\b([^>]*)>([\s\S]*?)<\/spine>/i,
            (match, attrs, inner) => {
                const refs = [];
                inner.replace(/<itemref\b([^>]*)\/?>(?:<\/itemref>)?/gi, (m, refAttrs) => {
                    refAttrs = refAttrs.replace(/\s*\/$/, '');
                    refs.push('    <itemref' + refAttrs + '/>');
                    return m;
                });
                return '<spine' + attrs + '>\n' + refs.join('\n') + '\n  </spine>';
            }
        );
        return text;
    }
}
