"use strict";

class Main {
    constructor() {
        this.epub = new Epub();
    }   

    dragOverHandler(ev) {
        console.log('File(s) in drop zone'); 
      
        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();
    }    

    dropHandler(ev) {
        console.log('File(s) dropped');
      
        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();
      
        let file = null;
        if (ev.dataTransfer.items) {
          // Use DataTransferItemList interface to access the file(s)
            for (let i = 0; i < ev.dataTransfer.items.length; i++) {
            // If dropped items aren't files, reject them
                if (ev.dataTransfer.items[i].kind === 'file') {
                    file = ev.dataTransfer.items[i].getAsFile();
                    // only process first file
                    break;
                }
            }
        } else {
          // Use DataTransfer interface to access the file(s)
            if (0 < ev.dataTransfer.files.length) {
                file = ev.dataTransfer.files[0];
            }
        }
        this.processFile(file, ev);
    }

    processFile(file, ev) {
        if (file !== null) {
            console.log('... file.name = ' + file.name);
            this.fileName = file.name;
            this.epub = new Epub();
            this.resetUI();
            return this.epub.load(file)
                .then(() => this.removeDragData(ev))
                .then(() => this.onEpubLoaded())
                .catch(e => window.alert(e));
        }
    }    

    removeDragData(ev) {
        if (ev == null) {
            return;
        }

        console.log('Removing drag data')
      
        if (ev.dataTransfer.items) {
            // Use DataTransferItemList interface to remove the drag data
            ev.dataTransfer.items.clear();
        } else {
            // Use DataTransfer interface to remove the drag data
            ev.dataTransfer.clearData();
        }
    }

    onFileNameInputChange(fileNameInput) {
        this.processFile(fileNameInput.files[0], null);
    }

    onEpubLoaded() {
        if (this.epub?.getMetadata && document.getElementById("metadataTitleInput")) {
            this.populateMetadataForm(this.epub.getMetadata(), "metadata");
        }

        document.getElementById("controls").hidden = false;
    }



    getMetadataFormValues(prefix = "metadata") {
        return {
            title: document.getElementById(prefix + "TitleInput")?.value ?? "",
            author: document.getElementById(prefix + "AuthorInput")?.value ?? "",
            subject: document.getElementById(prefix + "SubjectInput")?.value ?? "",
            description: document.getElementById(prefix + "DescriptionInput")?.value ?? ""
        };
    }

    populateMetadataForm(metadata, prefix = "metadata") {
        metadata = metadata || {};
        const title = document.getElementById(prefix + "TitleInput");
        const author = document.getElementById(prefix + "AuthorInput");
        const subject = document.getElementById(prefix + "SubjectInput");
        const description = document.getElementById(prefix + "DescriptionInput");
        if (title) title.value = metadata.title || "";
        if (author) author.value = metadata.author || "";
        if (subject) subject.value = metadata.subject || "";
        if (description) description.value = metadata.description || "";
    }

    updateMetadata() {
        const metadata = this.getMetadataFormValues("metadata");
        return this.epub.updateMetadata(
            metadata.title,
            metadata.author,
            metadata.subject,
            metadata.description
        ).then(() => this.epub.save(this.fileName, "application/epub+zip"));
    }


    mergeSelectedEpubs() {
        const files = this.mergeEpubFilesOrder || [];

        if (files.length < 2) {
            window.alert("Add at least two EPUB files to the merge order.");
            return;
        }

        const button = document.getElementById("mergeEpubButton");
        const status = document.getElementById("mergeEpubStatus");
        button.disabled = true;

        if (status) {
            status.textContent = "Merging " + files.length + " EPUBs...";
        }

        const metadata = this.getMetadataFormValues("mergeMetadata");

        return EpubMerger.merge(files, metadata)
            .then(result => {
                const baseName =
                    files[0].name.replace(/\.epub$/i, "");

                const url = URL.createObjectURL(result.blob);
                const a = document.createElement("a");

                a.href = url;
                a.download = baseName + "_merged.epub";
                a.click();

                setTimeout(
                    () => URL.revokeObjectURL(url),
                    60000
                );

                if (status) {
                    status.textContent =
                        "Merged " + files.length +
                        " EPUBs (" + result.chapterCount +
                        " spine entries). Download started.";
                }

                document.getElementById("listHeader").textContent =
                    "Merged " + files.length +
                    " EPUBs (" + result.chapterCount +
                    " spine entries).";
            })
            .catch(e => {
                if (status) {
                    status.textContent =
                        "Merge failed: " + (e && e.message ? e.message : e);
                }
                window.alert(
                    "Failed to merge EPUBs: " +
                    (e && e.message ? e.message : e)
                );
            })
            .finally(() => {
                button.disabled = this.mergeEpubFilesOrder.length < 2;
            });
    }

    addMergeEpubFiles(fileList) {
        const incoming = Array.from(fileList || []);
        const previousBase = this.mergeEpubFilesOrder[0] || null;

        for (const file of incoming) {
            if (!/\.epub$/i.test(file.name)) {
                continue;
            }

            const duplicate = this.mergeEpubFilesOrder.some(existing =>
                existing.name === file.name &&
                existing.size === file.size &&
                existing.lastModified === file.lastModified
            );

            if (!duplicate) {
                this.mergeEpubFilesOrder.push(file);
            }
        }

        this.renderMergeEpubOrder();

        const newBase = this.mergeEpubFilesOrder[0] || null;
        if (newBase && newBase !== previousBase) {
            this.loadMergeBaseMetadata(newBase);
        }
    }

    loadMergeBaseMetadata(file) {
        if (!file) {
            this.populateMetadataForm({}, "mergeMetadata");
            return;
        }

        const epub = new Epub();
        return epub.load(file)
            .then(() => {
                this.populateMetadataForm(epub.getMetadata(), "mergeMetadata");
            })
            .catch(error => {
                console.warn("Could not read base EPUB metadata for merge:", error);
                this.populateMetadataForm({}, "mergeMetadata");
            });
    }

    removeMergeEpub(index) {
        const previousBase = this.mergeEpubFilesOrder[0] || null;
        this.mergeEpubFilesOrder.splice(index, 1);
        this.renderMergeEpubOrder();

        const newBase = this.mergeEpubFilesOrder[0] || null;
        if (newBase !== previousBase) {
            this.loadMergeBaseMetadata(newBase);
        }
    }

    moveMergeEpub(index, direction) {
        const target = index + direction;

        if (
            target < 0 ||
            target >= this.mergeEpubFilesOrder.length
        ) {
            return;
        }

        const files = this.mergeEpubFilesOrder;
        const previousBase = files[0] || null;
        const temp = files[index];
        files[index] = files[target];
        files[target] = temp;

        this.renderMergeEpubOrder();

        const newBase = files[0] || null;
        if (newBase !== previousBase) {
            this.loadMergeBaseMetadata(newBase);
        }
    }

    clearMergeEpubs() {
        this.mergeEpubFilesOrder = [];
        this.renderMergeEpubOrder();
        this.populateMetadataForm({}, "mergeMetadata");

        const input = document.getElementById("mergeEpubFiles");
        if (input) {
            input.value = "";
        }
    }

    renderMergeEpubOrder() {
        const list = document.getElementById("mergeEpubOrder");
        const empty = document.getElementById("mergeEmptyMessage");
        const count = document.getElementById("mergeEpubCount");
        const warning = document.getElementById("mergeDuplicateWarning");
        const button = document.getElementById("mergeEpubButton");

        if (!list) {
            return;
        }

        const files = this.mergeEpubFilesOrder || [];
        list.textContent = "";

        files.forEach((file, index) => {
            const item = document.createElement("li");
            item.className = "merge-epub-item";
            item.draggable = true;
            item.dataset.index = String(index);

            item.addEventListener("dragstart", event => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
                item.classList.add("merge-dragging");
            });

            item.addEventListener("dragend", () => {
                item.classList.remove("merge-dragging");
            });

            item.addEventListener("dragover", event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                item.classList.add("merge-drag-over");
            });

            item.addEventListener("dragleave", () => {
                item.classList.remove("merge-drag-over");
            });

            item.addEventListener("drop", event => {
                event.preventDefault();
                item.classList.remove("merge-drag-over");

                const from = Number(
                    event.dataTransfer.getData("text/plain")
                );
                const to = index;

                if (
                    Number.isInteger(from) &&
                    from !== to &&
                    from >= 0 &&
                    from < files.length
                ) {
                    const moved = files.splice(from, 1)[0];
                    const previousBase = files[0] || null;
                    files.splice(to, 0, moved);
                    this.renderMergeEpubOrder();
                    const newBase = files[0] || null;
                    if (newBase !== previousBase) {
                        this.loadMergeBaseMetadata(newBase);
                    }
                }
            });

            const handle = document.createElement("span");
            handle.className = "merge-drag-handle";
            handle.textContent = "☷";
            handle.title = "Drag to reorder";
            handle.setAttribute("aria-hidden", "true");

            const number = document.createElement("span");
            number.className = "merge-order-number";
            number.textContent = String(index + 1) + ".";

            const info = document.createElement("span");
            info.className = "merge-file-info";

            const name = document.createElement("strong");
            name.textContent = file.name;

            const meta = document.createElement("small");
            meta.textContent = this.formatMergeFileSize(file.size);

            info.appendChild(name);
            info.appendChild(meta);

            if (index === 0) {
                const base = document.createElement("span");
                base.className = "merge-base-badge";
                base.textContent = "BASE";
                info.appendChild(base);
            }

            const actions = document.createElement("span");
            actions.className = "merge-item-actions";

            const up = document.createElement("button");
            up.type = "button";
            up.textContent = "↑";
            up.title = "Move up";
            up.disabled = index === 0;
            up.onclick = () => this.moveMergeEpub(index, -1);

            const down = document.createElement("button");
            down.type = "button";
            down.textContent = "↓";
            down.title = "Move down";
            down.disabled = index === files.length - 1;
            down.onclick = () => this.moveMergeEpub(index, 1);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "×";
            remove.title = "Remove EPUB";
            remove.onclick = () => this.removeMergeEpub(index);

            actions.appendChild(up);
            actions.appendChild(down);
            actions.appendChild(remove);

            item.appendChild(handle);
            item.appendChild(number);
            item.appendChild(info);
            item.appendChild(actions);
            list.appendChild(item);
        });

        if (count) {
            count.textContent =
                files.length + " EPUB" +
                (files.length === 1 ? "" : "s");
        }

        if (empty) {
            empty.hidden = files.length !== 0;
        }

        if (button) {
            button.disabled = files.length < 2;
        }

        if (warning) {
            const names = new Map();

            files.forEach(file => {
                const key = file.name.toLowerCase();
                names.set(key, (names.get(key) || 0) + 1);
            });

            const duplicates = Array.from(names.entries())
                .filter(([, copies]) => copies > 1)
                .map(([name, copies]) =>
                    name + " (" + copies + " copies)"
                );

            warning.hidden = duplicates.length === 0;
            warning.textContent = duplicates.length
                ? "Duplicate filename(s): " +
                  duplicates.join(", ") +
                  ". They are kept as separate EPUBs."
                : "";
        }
    }

    formatMergeFileSize(bytes) {
        if (!Number.isFinite(bytes)) {
            return "";
        }

        if (bytes < 1024) {
            return bytes + " B";
        }

        if (bytes < 1024 * 1024) {
            return (bytes / 1024).toFixed(1) + " KB";
        }

        if (bytes < 1024 * 1024 * 1024) {
            return (bytes / (1024 * 1024)).toFixed(1) + " MB";
        }

        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }


    checkForInvalidXhtml() {
        let that = this;
        this.epub.checkForInvalidXhtml().then(function (invalid) {
            let header = document.getElementById("listHeader");
            header.textContent = (0 == invalid.length) ? "No invalid files found" : "Following XHTML files are not valid";
            that.populateList(invalid.map(i => i.zipObjectName));
        });
    }

    checkForZeroSizeImages() {
        let images = this.epub.findZeroSizeImages();
        let headerText = (0 == images.length) ? "No zero size images found" : "Following zero size images found";
        let header = document.getElementById("listHeader");
        header.textContent = headerText;
        this.populateList(images.map(i => i.outerHTML));
    }

    extractImages() {
        return this.epub.extractImages("test.zip", 1)
            .catch(e => window.alert(e));
    }

    waterMarkEpub() {
        let watermark = document.getElementById("watermark").value;
        let epub = this.epub;
        return epub.watermarkContent(watermark)
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    removeElementsMatchingCss() {
        let css = document.getElementById("removeCssInput").value;
        let epub = this.epub;
        return epub.removeElementsMatchingCss(css)
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    cleanChrysanthemumGarden() {
        let css = document.getElementById("removeCssInput").value;
        let epub = this.epub;
        return epub.cleanChrysanthemumGarden(css)
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    runScript() {
        let script = document.getElementById("mutatorScriptInput").value;
        let mode = document.getElementById("scriptModeSelect").value;
        let epub = this.epub;
        let operation = mode === "raw" ? epub.runRawScript(script) : epub.runScript(script);
        return operation
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    runScriptAsync() {
        let script = document.getElementById("mutatorScriptInput").value;
        let mode = document.getElementById("scriptModeSelect").value;
        let epub = this.epub;
        let operation = mode === "raw" ? epub.runRawScriptAsync(script) : epub.runScriptAsync(script);
        return operation
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    sanitizeXhtml() {
        let epub = this.epub;
        return epub.sanitizeXhtml()
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }
    
    convertTableToDiv() {
        let epub = this.epub;
        return epub.convertTableToDiv()
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    appendSourceLinkInEachChapter() {
        let epub = this.epub;
        return epub.appendSourceLinkInEachChapter()
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    linkExtraFonts() {
        let epub = this.epub;
        return epub.linkExtraFonts()
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }


    updateTocTitlesFromHeading() {
        let epub = this.epub;
        const headingMode = document.getElementById("updateTocHeadingLevel").value;
        return epub.updateTocTitlesFromHeading(headingMode)
            .then(updated => {
                document.getElementById("listHeader").textContent =
                    "Updated " + updated + " TOC entries from chapter headings (H1-H6)";
                return epub.save(this.fileName, "application/epub+zip");
            });
    }

    updateDate() {
        let dateString = document.getElementById("updateDateInput").value;
        let epub = this.epub;
        return epub.updateDate(dateString)
            .then(() => epub.save(this.fileName, "application/epub+zip"));
    }

    removeZeroSizeImages() {
        return this.removeImages(this.epub.findZeroSizeImages());
    }

    removeAllImages() {
        return this.removeImages(this.epub.findAllImagesExceptCover());
    }

    removeImages(images) {
        return this.epub.removeTagsForImages(images)
            .then(() => this.epub.removeItems(images))
            .then(() => this.epub.save(this.fileName, "application/epub+zip"));
    }

    listImagesInViewOrder() {
        return this.epub.listImagesInViewOrder()
            .then(images => this.dumpImageNames(images));
    }

    dumpImageNames(items) {
        let listElement = document.getElementById("fileList");
        let expected = 0;
        for(let item of items) {
            let li = document.createElement("li");
            li.textContent = item;
            let actual = parseInt(item);
            if (actual != expected) {
                li.style = "color: red;";
            }
            expected = actual + 1;
            listElement.appendChild(li);
        }
    }

    populateList(items) {
        let listElement = document.getElementById("fileList");
        for(let item of items) {
            let li = document.createElement("li");
            li.textContent = item;
            listElement.appendChild(li);
        }
    }

    resetUI() {
        document.getElementById("controls").hidden = true;
        document.getElementById("listHeader").textContent = "";
        for(let e of document.querySelectorAll("ol#fileList  li")) {
            e.remove();
        }
    }

    listXhtmlFiles() {
        // ToDo, remove this diagnostics code
        this.populateList(this.epub.opf.xhtmlNames());
    }

    start() {
        let control = document.getElementById("drop_zone");
        control.ondrop = this.dropHandler.bind(this);
        control.ondragover = this.dragOverHandler.bind(this);
        document.getElementById("checkForInvalidXhtmlButton").onclick = this.checkForInvalidXhtml.bind(this);
        document.getElementById("checkForZeroSizeImagesButton").onclick = this.checkForZeroSizeImages.bind(this);
        document.getElementById("watermarkButton").onclick = this.waterMarkEpub.bind(this);
        document.getElementById("removeZeroSizeImagesButton").onclick = this.removeZeroSizeImages.bind(this);
        document.getElementById("listImagesButton").onclick = this.listImagesInViewOrder.bind(this);
        document.getElementById("removeAllImagesButton").onclick = this.removeAllImages.bind(this);
        document.getElementById("extractImagesButton").onclick = this.extractImages.bind(this);
        document.getElementById("removeElementsButton").onclick = this.removeElementsMatchingCss.bind(this);
        document.getElementById("cleanChrysanthemumGardenButton").onclick = this.cleanChrysanthemumGarden.bind(this);
        document.getElementById("sanitizeButton").onclick = this.sanitizeXhtml.bind(this);
        document.getElementById("convertTableToDivButton").onclick = this.convertTableToDiv.bind(this);
        document.getElementById("appendSourceLinkInEachChapterButton").onclick = this.appendSourceLinkInEachChapter.bind(this);
        document.getElementById("linkExtraFontsButton").onclick = this.linkExtraFonts.bind(this);
        document.getElementById("updateDateButton").onclick = this.updateDate.bind(this);
        document.getElementById("updateMetadataButton").onclick = this.updateMetadata.bind(this);
        document.getElementById("updateTocTitlesFromHeadingButton").onclick = this.updateTocTitlesFromHeading.bind(this);
        this.mergeEpubFilesOrder = [];

        document.getElementById("mergeEpubFiles").addEventListener(
            "change",
            event => {
                this.addMergeEpubFiles(event.target.files);
                event.target.value = "";
            }
        );

        document.getElementById("mergeClearButton").onclick =
            this.clearMergeEpubs.bind(this);

        document.getElementById("mergeEpubButton").onclick =
            this.mergeSelectedEpubs.bind(this);

        this.renderMergeEpubOrder();

        document.getElementById("runScriptButton").onclick = this.runScript.bind(this);
        document.getElementById("runScriptAsyncButton").onclick = this.runScriptAsync.bind(this);

        const scriptMode = document.getElementById("scriptModeSelect");
        const scriptInput = document.getElementById("mutatorScriptInput");
        const domExample = scriptInput.value;
        const rawExample = String.raw`// Raw XHTML mode: html is the original XHTML string for each chapter
// zipObjectName is the EPUB path of the current chapter
// Return true to save the current html, false to leave it unchanged.
// You can directly reassign html and the original markup is preserved.
const chapterTitle =
    /^\s*(?:chapter|ch\.?)\s*(?:\d+|[IVXLCDM]+)\s*(?:[:.\-–—]\s*.*)?\s*$/i;

const tagRegex = /<(p|h2|h3|h4|h5|h6)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const original = html;

html = html.replace(tagRegex, match => {
    // Remove XHTML tags to get the actual text
    const text = match
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();

    // Remove the entire element if it is a chapter title
    return chapterTitle.test(text) ? "" : match;
});

return html !== original;`;
        const scriptHelp = document.getElementById("scriptModeHelp");
        const updateScriptMode = () => {
            if (scriptMode.value === "raw") {
                scriptHelp.textContent = "Raw mode works on the original XHTML text and does not use XMLSerializer. Unrelated whitespace/formatting is preserved.";
                if (scriptInput.value === domExample) scriptInput.value = rawExample;
            } else {
                scriptHelp.textContent = "DOM mode parses each XHTML file and serializes it again when modified.";
                if (scriptInput.value === rawExample) scriptInput.value = domExample;
            }
        };
        scriptMode.onchange = updateScriptMode;

        if (window.initResourceManager) window.initResourceManager(this);

        const fileNameInput = document.getElementById('fileNameInput');
        fileNameInput.addEventListener("change", () => this.onFileNameInputChange(fileNameInput), false);
    }
}

let main = new Main();
main.start();
