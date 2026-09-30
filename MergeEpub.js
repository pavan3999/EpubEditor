/* Android/browser EPUB merger for EpubEditor.
 *
 * First selected EPUB = base.
 * Remaining EPUBs = appended in order.
 *
 * Appended EPUB content is copied below Merge_NNN/, so relative links
 * between its XHTML/CSS/images/fonts remain valid.
 */
"use strict";

class EpubMerger {
    static async merge(files) {
        if (!files || files.length < 2) {
            throw new Error("Select at least two EPUB files.");
        }

        const epubs = [];
        for (const file of files) {
            epubs.push(await JSZip.loadAsync(file));
        }

        const base = epubs[0];
        const baseInfo = await this.readEpubInfo(base);
        let mergeIndex = 1;

        for (let i = 1; i < epubs.length; i++) {
            const srcZip = epubs[i];
            const srcInfo = await this.readEpubInfo(srcZip);
            const prefix = "Merge_" + String(mergeIndex++).padStart(3, "0") + "/";

            const nameMap = new Map();

            // Copy all content except EPUB container metadata and the source
            // OPF/NCX/nav documents themselves.
            for (const name of Object.keys(srcZip.files)) {
                const entry = srcZip.files[name];

                if (entry.dir ||
                    name === "mimetype" ||
                    name === "META-INF/container.xml" ||
                    name === srcInfo.opfName ||
                    name === srcInfo.ncxName ||
                    name === srcInfo.navName) {
                    continue;
                }

                const newName = prefix + name;
                nameMap.set(name, newName);

                const data = await entry.async("uint8array");
                base.file(newName, data, this.zipOptions(entry));
            }

            const srcOpfDir = this.dirname(srcInfo.opfName);
            const baseOpfDir = this.dirname(baseInfo.opfName);

            // Copy manifest entries and give them unique IDs.
            const idMap = new Map();
            const baseManifest = baseInfo.opfDom.querySelector("manifest");

            for (const item of Array.from(srcInfo.opfDom.querySelectorAll("manifest > item"))) {
                const oldId = item.getAttribute("id");
                const href = item.getAttribute("href");

                if (!oldId || !href) {
                    continue;
                }

                const sourcePath = this.resolvePath(srcOpfDir, href);
                const mappedPath = nameMap.get(sourcePath);

                if (!mappedPath) {
                    continue;
                }

                let newId = oldId;
                let suffix = 1;

                while (Array.from(baseManifest.querySelectorAll("item")).some(
                    x => x.getAttribute("id") === newId
                )) {
                    newId = oldId + "_m" + i + "_" + suffix++;
                }

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
                            this.relativePath(baseOpfDir, mappedPath)
                        );
                    } else {
                        newItem.setAttribute(attr.name, attr.value);
                    }
                }

                baseManifest.appendChild(newItem);
            }

            // Append spine entries.
            const baseSpine = baseInfo.opfDom.querySelector("spine");

            for (const ref of Array.from(
                srcInfo.opfDom.querySelectorAll("spine > itemref")
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

            // EPUB 2 NCX.
            if (baseInfo.ncxDom && srcInfo.ncxDom) {
                const baseNavMap = baseInfo.ncxDom.querySelector("navMap");
                const srcNavMap = srcInfo.ncxDom.querySelector("navMap");

                if (baseNavMap && srcNavMap) {
                    let playOrder = this.maxPlayOrder(baseNavMap) + 1;

                    for (const navPoint of Array.from(srcNavMap.children)) {
                        if (navPoint.localName !== "navPoint") {
                            continue;
                        }

                        const clone = navPoint.cloneNode(true);
                        this.rewriteNcxNode(
                            clone,
                            srcInfo.ncxName,
                            baseInfo.ncxName,
                            nameMap
                        );

                        for (const point of [
                            clone,
                            ...Array.from(clone.querySelectorAll("navPoint"))
                        ]) {
                            if (point.hasAttribute("playOrder")) {
                                point.setAttribute("playOrder", String(playOrder++));
                            }
                        }

                        baseNavMap.appendChild(
                            baseInfo.ncxDom.importNode(clone, true)
                        );
                    }
                }
            }

            // EPUB 3 / WebToEpub XHTML navigation.
            if (baseInfo.navDom && srcInfo.navDom) {
                const baseToc = this.findTocNav(baseInfo.navDom);
                const srcToc = this.findTocNav(srcInfo.navDom);

                if (baseToc && srcToc) {
                    for (const child of Array.from(srcToc.children)) {
                        const clone = child.cloneNode(true);

                        this.rewriteHrefAttributes(
                            clone,
                            srcInfo.navName,
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

        // Save modified structural files.
        base.file(
            baseInfo.opfName,
            this.serializeXml(baseInfo.opfDom),
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

    static async readEpubInfo(zip) {
        const container = await this.readXml(zip, "META-INF/container.xml");
        const rootfile = container.querySelector("rootfile");

        if (!rootfile) {
            throw new Error("Invalid EPUB: container.xml has no rootfile.");
        }

        const opfName = rootfile.getAttribute("full-path");
        const opfDom = await this.readXml(zip, opfName);
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
            "application/xml"
        );

        if (dom.querySelector("parsererror")) {
            throw new Error("Invalid XML in EPUB: " + name);
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

    static serializeXml(dom) {
        return new XMLSerializer().serializeToString(dom);
    }
}
