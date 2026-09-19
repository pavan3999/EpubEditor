"use strict";

/** Functions for manipulating the Opf file */
class Opf {
    constructor(dom, zipObjectName) {
        this.dom = dom;
        this.zipObjectName = zipObjectName;
        this.zipPath = this.extractPath(zipObjectName);
        this.items = [...dom.querySelectorAll("manifest item")]
            .reduce(function(prev, curr) {
                prev.set(curr.getAttribute("id"), curr);
                return prev;
            }, new Map());
    }

    extractPath(zipObjectName) {
        let path = zipObjectName.split("/");
        path = path.slice(0, path.length - 1);
        path = path.join("/");
        if (0 < path.length){
            path += "/"
        }
        return path;
    }

    xhtmlNames() {
        return [...this.spine()]
            .map(itemref => itemref.getAttribute("idref"))
            .filter(idref => idref !== "cover")
            .map(idref => this.zipPath + this.items.get(idref).getAttribute("href"))
    }

    imageFileItems() {
        let images = [];
        for(let item of this.items.values()) {
            if (item.getAttribute("media-type").startsWith("image/")) {
                images.push(item);
            }
        }
        return images;
    }

    spine() {
        return this.dom.querySelectorAll("spine itemref");
    }

    makeFullPath(partial) {
        return this.zipPath + partial;
    }

    zipNameForItem(item) {
        return this.makeFullPath(item.getAttribute("href"));
    }

    removeItems(items) {
        let modified = false;
        for(let item of items) {
            let id = item.id;
            let itemref = this.dom.querySelector("spine itemref[idref='"+id+"']");
            if (itemref !== null) {
                itemref.remove();
            }
            let source = this.dom.querySelector("metadata [id='id."+id+"']");
            if (source !== null) {
                source.remove();
            }
            item.remove();
            modified = true;
        }
        return modified;
    }
}

class ImageRemover {
    constructor(opf, imagesToRemove) {
        this.zipNames = new Set();
        for(let item of imagesToRemove) {
            this.zipNames.add(opf.zipNameForItem(item));
        }
    }

    removeTagsForImages(dom, zipName) {
        let modified = false;
        for(let element of dom.querySelectorAll("img, image")) {
            if (this.isImageToRemove(element, zipName)) {
                modified = true;
                this.remove(element);
            }
        }
        return modified;
    }

    isImageToRemove(element, zipName) {
        let attribName = (element.tagName.toUpperCase() === "IMG") ? "src" : "xlink:href";
        let src = this.resolveZipName(element.getAttribute(attribName), zipName);
        return this.zipNames.has(src);
    }

    remove(element) {
        if (element.tagName.toUpperCase() === "IMG") {
            element.remove();
        } else {
            element.parentElement.remove();
        }
    }

    resolveZipName(ref, zipNameHoldingRef) {
        let origin = zipNameHoldingRef.split("/");
        origin = origin.slice(0, origin.length - 1);
        let refBits = ref.split("/");
        while(refBits[0] === "..") {
            if (0 < origin.length) {
                origin = origin.slice(0, origin.length - 1);
            }
            refBits = refBits.slice(1, refBits.length);
        }
        return origin.concat(refBits).join("/");
    }
}

class Epub {
    constructor() {
        this.zip = null;
        this.zipObjects = new Map();
        this.opf = null;
    }

    /** Read file object, assumed to be an epub */
    load(file) {
        let that = this;
        return this.loadFileToArrayBuffer(file)
            .then(array => new JSZip().loadAsync(array))
            .then(zip => this.buildListOfFiles(zip))
            .then(() => this.locateOpf())
            .then(opfName => this.parseOpf(opfName))
    } 

    /** Write the watermark to end of each XHTML file (excluding cover) in epub */
    watermarkContent(watermark) {
        let watermarkFile = function(dom) {
            let div = dom.createElementNS("http://www.w3.org/1999/xhtml", "div");
            div.innerHTML = watermark;
            dom.body.appendChild(div);
            return true;
        };
        return this.processEachXhtmlFile(watermarkFile);
    }

    /** Write modified epub to disk with requested filename */
    save(filename, mimeType) {
        // need to make a copy of the zip file, otherwise files are not 
        // compressed.
        return this.copyZip()
            .then(newZip => newZip.generateAsync({ type: "blob", "mimeType": mimeType ?? "application/zip" }))
            .then(blob => this.writeToDisk(filename, blob));
    }

    /* private */
    needsWatermark(file) {
        // ToDo, replace this with real logic
        return file.name === "OEBPS/Text/0001_1_Chapter_...sing_Death.xhtml";
    }

    /** private */
    loadFileToArrayBuffer(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function(e) {
                resolve(e.target.result);
            }
            reader.readAsArrayBuffer(file);
        });
    }

    /** private */
    buildListOfFiles(zip) {
        this.zip = zip;
        let zipObjects = new Map();
        this.zipObjects = zipObjects;
        this.zip.forEach(function (relativePath, file) {
            if (!file.dir) {
                zipObjects.set(file.name, file);
            }
        });
    }

    /* private */
    copyZip() {
        let that = this;
        let newZip = new JSZip();
        var sequence = Promise.resolve();
        this.zip.forEach(function (relativePath, file) {
            if (!file.dir) {
                sequence = sequence.then(function () {
                    return that.copyFile(file, newZip);
                });
            }
        });
        sequence = sequence.then(() => Promise.resolve(newZip));
        return sequence;
    }

    /** private */
    copyFile(file, newZip) {
        let that = this;
        return file.async("blob").then(function (blob){
            let options = that.createZipOptions(file);
            return newZip.file(file.name, blob, options);
        });
    }

    /** private */
    createZipOptions(file) {
        let options = {
            date: file.date,
        };
        if (this.isCompressed(file)) {
            options.compression = "DEFLATE";
        }
        return options;
    }

    /** private */
    isCompressed(file) {
        if (file.options.compression === "DEFLATE") {
            return true;
        };
        let data = file["_data"];
        if (data !== undefined) {
            return data.compressedSize < data.uncompressedSize;
        }
        return false;
    }

    /** private */
    writeToDisk(filename, blob) {
        let options = {
            url: URL.createObjectURL(blob),
            saveAs: true
        };
        let cleanup = () => { URL.revokeObjectURL(options.url); };
        let clickEvent = new MouseEvent("click", {
            "view": window,
            "bubbles": true,
            "cancelable": false
        });
        let a = document.createElement("a");
        a.href = options.url;
        a.download = filename;
        a.dispatchEvent(clickEvent);
        const oneMinute = 60 * 1000;
        setTimeout(cleanup, oneMinute);
        return Promise.resolve();
    }

    extractXhtnml(zipObjectName) {
        let file = this.zipObjects.get(zipObjectName);
        return file.async("text").then(function (text){
            return new DOMParser().parseFromString(text, "text/html");
        });
    }
    
    locateOpf() {
        return this.extractXhtnml("META-INF/container.xml").then(function (container) {
            return container.querySelector("rootfile").getAttribute("full-path");
        });
    }
    
    parseOpf(opfName) {
        let that = this;
        return this.extractXhtnml(opfName).then(function (dom) {
            that.opf = new Opf(dom, opfName);
        });
    }

    findZeroSizeImages() {
        let opf = this.opf;
        let toRemove = opf.imageFileItems()
            .filter(item => this.isZeroLength(opf.zipNameForItem(item)));
        return toRemove;
    }

    findAllImagesExceptCover() {
        return this.opf.imageFileItems()
            .filter(item => item.getAttribute("id") !== "cover-image");
    }

    removeTagsForImages(imagesToRemove) {
        let remover = new ImageRemover(this.opf, imagesToRemove);
        let mutator = (dom, zipObjectName) => remover.removeTagsForImages(dom, zipObjectName);
        return this.processEachXhtmlFile(mutator);
    }

    removeElementsMatchingCss(css) {
        let mutator = function(dom, zipObjectName) {
            let altered = false;
            for(let e of dom.querySelectorAll(css)) {
                e.remove();
                altered = true;
            }
            return altered;
        }
        return this.processEachXhtmlFile(mutator);
    }

    async getDecryptForFonts() {
        const loadScript = (src) => new Promise((onload) => document.documentElement.append(
            Object.assign(document.createElement('script'), {src, onload})
        ));

        const glyphToCharMapping = new Map([
            ["M585-20Q781-20 876 68Q971 156 971 349L971 1094L850 1094L818 932L810 932Q764 992 714 1032.50Q664 1073 598.50 1093.50Q533 1114 438 1114Q338 1114 260.50 1079Q183 1044 138.50 973Q94 902 94 793Q94 629 224 541Q354 453 620 445L809 437L809 370Q809 228 748 171Q687 114 576 114Q490 114 412 139Q334 164 264 198L213 72Q287 34 383 7Q479-20 585-20ZM807 655L807 554L640 561Q435 569 351 628Q267 687 267 795Q267 889 324 934Q381 979 475 979Q621 979 714 898Q807 817 807 655Z", "a"],
            ["M175-20L341-20L341 369Q341 436 337.50 499Q334 562 332 597L341 597Q386 523 471 472Q556 421 688 421Q894 421 1016.50 563.50Q1139 706 1139 987Q1139 1172 1083 1299Q1027 1426 925 1491Q823 1556 684 1556Q554 1556 470.50 1507.50Q387 1459 342 1389L329 1389L295 1536L175 1536ZM661 560Q542 560 472 606.50Q402 653 371.50 746.50Q341 840 341 983L341 992Q341 1199 410 1308.50Q479 1418 661 1418Q814 1418 890.50 1306Q967 1194 967 986Q967 774 891.50 667Q816 560 661 560Z", "b"],
            ["M614 1116Q466 1116 353 1055Q240 994 177 869Q114 744 114 554Q114 355 180.50 228.50Q247 102 364 41Q481-20 630-20Q712-20 788.50-3.50Q865 13 914 38L864 177Q814 157 748.50 141Q683 125 626 125Q512 125 436.50 174Q361 223 323.50 318Q286 413 286 552Q286 685 322.50 779Q359 873 431.50 922.50Q504 972 613 972Q700 972 770 953.50Q840 935 897 910L897 1058Q842 1086 774.50 1101Q707 1116 614 1116Z", "c"],
            ["M565 1556Q357 1556 235.50 1414Q114 1272 114 992Q114 709 238 564.50Q362 420 568 420Q655 420 720 443Q785 466 832 504.50Q879 543 911 592L923 592Q919 561 915 507Q911 453 911 419L911-20L1077-20L1077 1536L943 1536L918 1380L911 1380Q880 1429 832.50 1469Q785 1509 719.50 1532.50Q654 1556 565 1556ZM591 1418Q767 1418 840 1318Q913 1218 913 1021L913 991Q913 782 843.50 670Q774 558 591 558Q438 558 362 675.50Q286 793 286 996Q286 1198 361.50 1308Q437 1418 591 1418Z", "d"],
            ["M597-20Q737-20 837 42Q937 104 990 215.50Q1043 327 1043 476L1043 579L286 579Q289 772 382 873Q475 974 644 974Q748 974 828 955Q908 936 994 899L994 1045Q911 1082 829.50 1099Q748 1116 637 1116Q479 1116 361.50 1051.50Q244 987 179 862Q114 737 114 556Q114 379 173.50 249.50Q233 120 341.50 50Q450-20 597-20ZM595 116Q462 116 383 203Q304 290 289 446L869 446Q868 348 838.50 273.50Q809 199 749 157.50Q689 116 595 116Z", "e"],
            ["M663 471L663 601L390 601L390 1567L224 1567L224 601L30 601L30 521L224 466L224 393Q224 255 265 168.50Q306 82 384 41Q462 0 574 0Q637 0 689.50 11Q742 22 782 36L739 167Q705 156 662.50 146.50Q620 137 576 137Q481 137 435.50 198.50Q390 260 390 391L390 471Z", "f"],
            ["M481 1118Q265 1118 148 1037.50Q31 957 31 812Q31 709 96.50 636Q162 563 278 539Q235 519 204.50 479Q174 439 174 387Q174 327 207.50 281.50Q241 236 310 194Q224 159 170.50 75.50Q117-8 117-119Q117-237 166-320.50Q215-404 308-448Q401-492 533-492Q562-492 591.50-489.50Q621-487 648-482.50Q675-478 695-472L1071-472L1071-365L869-340Q899-301 919-246Q939-191 939-124Q939 40 828 136.50Q717 233 523 233Q477 233 429 225Q380 252 354.50 285Q329 318 329 361Q329 393 348.50 412Q368 431 405 439.50Q442 448 494 448L687 448Q866 448 961.50 523Q1057 598 1057 742Q1057 924 909 1021Q761 1118 481 1118ZM486 988Q622 988 711.50 960.50Q801 933 845.50 881.50Q890 830 890 759Q890 693 860 659.50Q830 626 772 614.50Q714 603 630 603L440 603Q366 603 311 626Q256 649 226.50 694Q197 739 197 806Q197 895 272 941.50Q347 988 486 988ZM529 112Q648 112 708 52Q768-8 768-123Q768-246 707-307.50Q646-369 527-369Q413-369 351.50-305.50Q290-242 290-120Q290-8 352 52Q414 112 529 112Z", "g"],
            ["M175 0L341 0L341 465Q341 505 339 545.50Q337 586 332 620L343 620Q377 562 429.50 522.50Q482 483 549 462.50Q616 442 691 442Q823 442 911.50 484Q1000 526 1044.50 614Q1089 702 1089 842L1089 1556L925 1556L925 853Q925 716 862.50 648Q800 580 671 580Q549 580 476.50 626.50Q404 673 372.50 763Q341 853 341 983L341 1556L175 1556Z", "h"],
            ["M175 410L341 410L341 1506L175 1506ZM260 0Q301 0 330.50 26.50Q360 53 360 109Q360 164 330.50 191Q301 218 260 218Q217 218 188.50 191Q160 164 160 109Q160 53 188.50 26.50Q217 0 260 0Z", "i"],
            ["M43 1506Q-8 1506-46 1498.50Q-84 1491-112 1481L-112 1346Q-81 1356-49 1361.50Q-17 1367 23 1367Q91 1367 133 1329Q175 1291 175 1191L175-82L341-82L341 1187Q341 1287 309 1358.50Q277 1430 211 1468Q145 1506 43 1506ZM160-383Q160-439 188.50-465.50Q217-492 260-492Q301-492 330.50-465.50Q360-439 360-383Q360-328 330.50-301Q301-274 260-274Q217-274 188.50-301Q160-328 160-383Z", "j"],
            ["M175 0L340 0L340 808Q340 848 337 905.50Q334 963 332 1007L339 1007Q360 981 400.50 930Q441 879 469 848L833 460L1028 460L587 928L1060 1556L860 1556L473 1037L340 1159L340 1556L175 1556Z", "k"],
            ["M342 0L342 1556L175 1556L175 0Z", "l"],
            ["M1365 0Q1546 0 1638 94.50Q1730 189 1730 398L1730 1116L1566 1116L1566 406Q1566 273 1508.50 206.50Q1451 140 1338 140Q1179 140 1107 232Q1035 324 1035 503L1035 1116L870 1116L870 406Q870 317 844.50 258Q819 199 768.50 169.50Q718 140 641 140Q532 140 466 185Q400 230 370.50 318.50Q341 407 341 536L341 1116L175 1116L175 20L309 20L334 175L343 175Q376 118 426 79Q476 40 538 20Q600 0 670 0Q795 0 879.50 46.50Q964 93 1002 188L1011 188Q1065 93 1159 46.50Q1253 0 1365 0Z", "m"],
            ["M694 0Q889 0 989 95.50Q1089 191 1089 402L1089 1116L925 1116L925 413Q925 276 862.50 208Q800 140 671 140Q489 140 415 243Q341 346 341 542L341 1116L175 1116L175 20L309 20L334 178L343 178Q378 120 432 80.50Q486 41 553 20.50Q620 0 694 0Z", "n"],
            ["M1120 546Q1120 681 1085 787Q1050 893 984 966Q918 1039 824.50 1077.50Q731 1116 613 1116Q503 1116 411.50 1077.50Q320 1039 253.50 966Q187 893 150.50 787Q114 681 114 546Q114 366 175 239.50Q236 113 349.50 46.50Q463-20 620-20Q770-20 882.50 47Q995 114 1057.50 240.50Q1120 367 1120 546ZM286 546Q286 678 321 775Q356 872 429 925Q502 978 617 978Q731 978 804.50 925Q878 872 913 775Q948 678 948 546Q948 415 913 319.50Q878 224 805 172Q732 120 616 120Q445 120 365.50 233Q286 346 286 546Z", "o"],
            ["M690-490Q895-490 1017-349Q1139-208 1139 75Q1139 262 1083 389Q1027 516 925.50 581Q824 646 686 646Q599 646 533 623Q467 600 420 561Q373 522 342 476L330 476Q333 515 337.50 570Q342 625 342 666L342 1116L175 1116L175-470L312-470L334-308L342-308Q374-358 420-399.50Q466-441 532.50-465.50Q599-490 690-490ZM661-350Q547-350 477.50-306Q408-262 376-174.50Q344-87 342 45L342 77Q342 216 372.50 312Q403 408 473.50 458Q544 508 663 508Q765 508 833 453Q901 398 934.50 299.50Q968 201 968 73Q968-121 892.50-235.50Q817-350 661-350Z", "p"],
            ["M1076 1116L910 1116L910 646Q910 607 912 556Q914 505 919 468L908 468Q862 544 777 595Q692 646 558 646Q357 646 235 504Q113 362 113 80Q113-105 169-232Q225-359 327.50-424.50Q430-490 567-490Q698-490 781-438.50Q864-387 911-313L919-313L944-470L1076-470ZM589 508Q705 508 775 464.50Q845 421 877.50 333Q910 245 912 114L912 79Q912-133 840-242.50Q768-352 589-352Q435-352 360-234.50Q285-117 285 84Q285 285 360 396.50Q435 508 589 508Z", "q"],
            ["M673 0Q706 0 742 3.50Q778 7 806 13L785 167Q758 160 725 156Q692 152 663 152Q597 152 538.50 178.50Q480 205 436 254.50Q392 304 367 373.50Q342 443 342 528L342 1116L175 1116L175 20L313 20L331 222L338 222Q372 161 420 110.50Q468 60 531.50 30Q595 0 673 0Z", "r"],
            ["M884 796Q884 901 831.50 972.50Q779 1044 681.50 1080Q584 1116 449 1116Q334 1116 250 1098Q166 1080 103 1047L103 894Q170 927 263 954Q356 981 453 981Q595 981 659 935Q723 889 723 810Q723 765 697.50 730.50Q672 696 612 663.50Q552 631 446 592Q341 552 264.50 512.50Q188 473 146.50 416Q105 359 105 268Q105 129 217.50 54.50Q330-20 513-20Q612-20 698.50-0.50Q785 19 860 52L804 185Q736 156 659 136Q582 116 502 116Q387 116 325.50 154Q264 192 264 258Q264 309 292.50 342Q321 375 384 404Q447 433 550 472Q653 510 728 550.50Q803 591 843.50 648.50Q884 706 884 796Z", "s"],
            ["M529 1214Q570 1214 613 1207Q656 1200 683 1190L683 1319Q654 1332 602.50 1341Q551 1350 502 1350Q415 1350 344 1319.50Q273 1289 230.50 1216Q188 1143 188 1014L188 364L32 364L32 283L189 218L255-20L355-20L355 234L676 234L676 364L355 364L355 1009Q355 1112 402.50 1163Q450 1214 529 1214Z", "t"],
            ["M913-20L1080-20L1080 1076L944 1076L920 922L911 922Q877 979 823 1018Q769 1057 701.50 1076.50Q634 1096 558 1096Q428 1096 340 1054Q252 1012 207.50 924Q163 836 163 698L163-20L331-20L331 686Q331 823 393 890.50Q455 958 582 958Q704 958 776.50 912Q849 866 881 776.50Q913 687 913 557Z", "u"],
            ["M606 1096L416 1096L0 0L178 0L419 663Q444 731 470 813Q496 895 506 945L513 945Q525 895 553 812.50Q581 730 604 663L845 0L1023 0Z", "v"],
            ["M1260 1098L1067 1098L872 460Q859 419 847.50 379.50Q836 340 826.50 303.50Q817 267 809.50 235.50Q802 204 797 181L790 181Q786 204 779 235.50Q772 267 762.50 304Q753 341 742 381.50Q731 422 717 463L513 1098L326 1098L24 2L196 2L354 607Q370 667 384.50 725.50Q399 784 409.50 835.50Q420 887 425 925L433 925Q439 900 446.50 865Q454 830 463.50 790.50Q473 751 484 711.50Q495 672 506 637L708 2L887 2L1082 636Q1097 684 1111.50 736Q1126 788 1138 836.50Q1150 885 1155 923L1163 923Q1167 889 1178 839Q1189 789 1203.50 729Q1218 669 1234 607L1394 2L1563 2Z", "w"],
            ["M39 1096L436 535L57 0L247 0L536 422L824 0L1012 0L633 535L1033 1096L843 1096L536 649L227 1096Z", "x"],
            ["M441 605L2-493L180-493L422 143Q443 199 461 250.50Q479 302 493 349Q507 396 515 440L522 440Q536 390 562 308.50Q588 227 618 142L847-493L1026-493L549 764Q511 865 460.50 940Q410 1015 338 1055.50Q266 1096 164 1096Q117 1096 81 1090.50Q45 1085 19 1078L19 945Q41 950 72.50 954Q104 958 138 958Q200 958 245.50 934.50Q291 911 324 866Q357 821 381 759Z", "y"],
            ["M879 967L879 1096L80 1096L80 986L681 130L118 130L118 0L866 0L866 123L273 967Z", "z"],
            ["M1293 1468L1117 1468L937 1004L351 1004L172 1468L0 1468L572 0L725 0ZM408 853L886 853L715 392Q709 374 695.50 333Q682 292 668 248Q654 204 645 177Q635 218 623.50 258.50Q612 299 601 333.50Q590 368 582 392Z", "A"],
            ["M200 1462L200 0L614 0Q888 0 1026 82Q1164 164 1164 361Q1164 446 1131.50 513.50Q1099 581 1037 625Q975 669 884 686L884 696Q980 711 1054 751Q1128 791 1170 863Q1212 935 1212 1046Q1212 1181 1149.50 1274Q1087 1367 973 1414.50Q859 1462 703 1462ZM370 145L370 627L650 627Q841 627 914.50 564Q988 501 988 380Q988 255 900.50 200Q813 145 622 145ZM659 770L370 770L370 1317L674 1317Q869 1317 950 1240.50Q1031 1164 1031 1034Q1031 951 994.50 892Q958 833 876.50 801.50Q795 770 659 770Z", "B"],
            ["M825 130Q704 130 607.50 171.50Q511 213 443.50 291.50Q376 370 340 481Q304 592 304 731Q304 915 361.50 1050.50Q419 1186 533.50 1260Q648 1334 820 1334Q918 1334 1004.50 1317.50Q1091 1301 1173 1276L1173 1424Q1093 1454 1005 1468.50Q917 1483 796 1483Q573 1483 423.50 1390.50Q274 1298 199.50 1129Q125 960 125 730Q125 564 171.50 426.50Q218 289 307.50 189Q397 89 527.50 34.50Q658-20 827-20Q938-20 1041 2Q1144 24 1227 65L1159 209Q1089 177 1005.50 153.50Q922 130 825 130Z", "C"],
            ["M1361 717Q1361 964 1271 1129.50Q1181 1295 1010.50 1378.50Q840 1462 597 1462L200 1462L200 0L641 0Q864 0 1025 81.50Q1186 163 1273.50 322.50Q1361 482 1361 717ZM1182 723Q1182 526 1116.50 398Q1051 270 924.50 207.50Q798 145 615 145L370 145L370 1316L577 1316Q879 1316 1030.50 1167Q1182 1018 1182 723Z", "D"],
            ["M1014 1312L1014 1462L200 1462L200 0L1014 0L1014 150L370 150L370 623L977 623L977 771L370 771L370 1312Z", "E"],
            ["M370 835L370 1462L200 1462L200 0L1014 0L1014 150L370 150L370 686L975 686L975 835Z", "F"],
            ["M825 849L825 697L1336 697L1336 1406Q1221 1445 1099.50 1464Q978 1483 828 1483Q600 1483 443.50 1392Q287 1301 206 1132.50Q125 964 125 732Q125 505 214.50 336Q304 167 473.50 73.50Q643-20 881-20Q1003-20 1112.50 2.50Q1222 25 1316 66L1251 214Q1170 179 1072.50 154Q975 129 871 129Q692 129 564.50 203Q437 277 369.50 412Q302 547 302 732Q302 915 361 1050.50Q420 1186 545 1261Q670 1336 867 1336Q966 1336 1037 1324.50Q1108 1313 1166 1297L1166 849Z", "G"],
            ["M1308 0L1308 1462L1138 1462L1138 773L370 773L370 1462L200 1462L200 0L370 0L370 623L1138 623L1138 0Z", "H"],
            ["M370 1462L200 1462L200 0L370 0Z", "I"],
            ["M-11 1462Q-61 1462-99 1455Q-137 1448-164 1436L-164 1291Q-132 1301-95 1306.50Q-58 1312-15 1312Q41 1312 88 1290Q135 1268 163 1215Q191 1162 191 1069L191-385L362-385L362 1056Q362 1193 316.50 1283Q271 1373 187.50 1417.50Q104 1462-11 1462Z", "J"],
            ["M650 634L1254 1462L1053 1462L526 751L370 891L370 1462L200 1462L200 0L370 0L370 729Q427 664 487 599.50Q547 535 606 469L1033 0L1232 0Z", "K"],
            ["M1019 1462L200 1462L200 0L370 0L370 1310L1019 1310Z", "L"],
            ["M982 1462L843 1462L352 168L344 168Q348 209 351 268Q354 327 356 396.50Q358 466 358 538L358 1462L200 1462L200 0L452 0L915 1216L922 1216L1392 0L1642 0L1642 1462L1474 1462L1474 526Q1474 461 1476 395.50Q1478 330 1481 271.50Q1484 213 1487 170L1479 170Z", "M"],
            ["M1343 0L1343 1462L1147 1462L350 234L342 234Q345 283 349 345.50Q353 408 355.50 478.50Q358 549 358 622L358 1462L200 1462L200 0L395 0L1189 1224L1196 1224Q1194 1189 1191 1124.50Q1188 1060 1185.50 985.50Q1183 911 1183 847L1183 0Z", "N"],
            ["M1468 732Q1468 901 1425 1039.50Q1382 1178 1297.50 1277.50Q1213 1377 1088 1431Q963 1485 798 1485Q628 1485 501.50 1431Q375 1377 291.50 1277Q208 1177 166.50 1038Q125 899 125 730Q125 506 199 337Q273 168 423.50 74Q574-20 801-20Q1018-20 1166.50 73Q1315 166 1391.50 334.50Q1468 503 1468 732ZM304 732Q304 918 357 1054Q410 1190 519.50 1264Q629 1338 798 1338Q968 1338 1076.50 1264Q1185 1190 1237 1054Q1289 918 1289 732Q1289 449 1170.50 289.50Q1052 130 801 130Q631 130 521 203Q411 276 357.50 410.50Q304 545 304 732Z", "O"],
            ["M200 0L582 0Q865 0 995.50 110.50Q1126 221 1126 427Q1126 520 1095.50 603.50Q1065 687 997 750.50Q929 814 818.50 850.50Q708 887 548 887L370 887L370 1462L200 1462ZM566 145L370 145L370 741L529 741Q669 741 762.50 711Q856 681 903 613.50Q950 546 950 434Q950 288 857 216.50Q764 145 566 145Z", "P"],
            ["M1468 404Q1468 584 1419 730Q1370 876 1273.50 977Q1177 1078 1033 1124L1377 1485L1134 1485L851 1155Q838 1155 824.50 1156Q811 1157 798 1157Q628 1157 501.50 1103Q375 1049 291.50 949Q208 849 166.50 710Q125 571 125 402Q125 178 199 9Q273-160 423.50-254Q574-348 801-348Q1018-348 1166.50-255Q1315-162 1391.50 6.50Q1468 175 1468 404ZM304 404Q304 590 357 726Q410 862 519.50 936Q629 1010 798 1010Q968 1010 1076.50 936Q1185 862 1237 726Q1289 590 1289 404Q1289 121 1170.50-38.50Q1052-198 801-198Q631-198 521-125Q411-52 357.50 82.50Q304 217 304 404Z", "Q"],
            ["M200 0L595 0Q775 0 892.50 44.50Q1010 89 1068 180Q1126 271 1126 412Q1126 528 1084 605.50Q1042 683 974 731Q906 779 829 805L1230 1462L1032 1462L674 852L370 852L370 1462L200 1462ZM585 147L370 147L370 708L602 708Q781 708 865.50 635Q950 562 950 420Q950 271 860.50 209Q771 147 585 147Z", "R"],
            ["M1025 1074Q1025 1204 960.50 1295.50Q896 1387 780 1435Q664 1483 507 1483Q424 1483 350 1475Q276 1467 214 1452Q152 1437 105 1415L105 1252Q180 1283 288 1309.50Q396 1336 514 1336Q624 1336 700 1306.50Q776 1277 815.50 1221.50Q855 1166 855 1088Q855 1013 822 962.50Q789 912 712.50 870.50Q636 829 504 782Q411 749 340 709.50Q269 670 221 620Q173 570 148.50 504Q124 438 124 353Q124 236 183.50 152.50Q243 69 348.50 24.50Q454-20 591-20Q708-20 807.50 2Q907 24 990 61L937 207Q858 174 769.50 152Q681 130 587 130Q493 130 428.50 157.50Q364 185 330 235Q296 285 296 354Q296 431 328.50 482Q361 533 432.50 572.50Q504 612 622 655Q751 702 841 754.50Q931 807 978 882.50Q1025 958 1025 1074Z", "S"],
            ["M649 150L649 1462L478 1462L478 150L18 150L18 0L1107 0L1107 150Z", "T"],
            ["M1137-20L1306-20L1306 926Q1306 1081 1243.50 1202Q1181 1323 1055 1392.50Q929 1462 739 1462Q468 1462 326.50 1315Q185 1168 185 922L185-20L356-20L356 927Q356 1113 454.50 1214Q553 1315 749 1315Q883 1315 968.50 1266.50Q1054 1218 1095.50 1130.50Q1137 1043 1137 928Z", "U"],
            ["M1041 0L1221 0L696 1462L525 1462L0 0L178 0L520 963Q541 1021 557.50 1074Q574 1127 587 1176Q600 1225 610 1271Q620 1225 633 1175.50Q646 1126 663 1072.50Q680 1019 701 960Z", "V"],
            ["M1683 0L1861 0L1470 1462L1299 1462L1009 478Q996 436 984.50 393.50Q973 351 963 312.50Q953 274 946.50 244.50Q940 215 937 200Q935 215 929.50 244Q924 273 915.50 311Q907 349 895.50 392Q884 435 871 479L589 1462L418 1462L30 0L207 0L442 917Q454 963 464.50 1007.50Q475 1052 483.50 1094Q492 1136 499 1176Q506 1216 512 1254Q517 1215 525 1172.50Q533 1130 542.50 1086Q552 1042 563.50 997Q575 952 588 907L851 0L1026 0L1300 914Q1314 961 1326 1007Q1338 1053 1347.50 1096.50Q1357 1140 1364.50 1179.50Q1372 1219 1378 1254Q1385 1205 1395 1151Q1405 1097 1418.50 1038Q1432 979 1448 916Z", "W"],
            ["M689 697L1176 1462L983 1462L588 818L187 1462L6 1462L493 700L40 0L229 0L594 583L961 0L1141 0Z", "X"],
            ["M186 0L573 733L962 0L1145 0L658 895L658 1462L488 1462L488 903L0 0Z", "Y"],
            ["M1093 1310L1093 1462L78 1462L78 1334L865 152L105 152L105 0L1072 0L1072 128L284 1310Z", "Z"],
        ]);

        const handleUnknownFont = async (fontPath) => {
            console.log("Decrypting font " + fontPath);
            const fontObject = this.zipObjects.get(fontPath);
            console.log("FontObject: " + fontObject);

            const buffer = fontObject.async("arraybuffer");

            // load wawoff2 if needed, and wait (!) for it to be ready
            if (!window.Module) {
                const path = 'https://unpkg.com/wawoff2@2.0.1/build/decompress_binding.js'
                const init = new Promise((done) => window.Module = { onRuntimeInitialized: done});
                await loadScript(path).then(() => init);
            }

            // decompress before parsing
            const font = opentype.parse(Module.decompress(await buffer));

            // Build decrypt string
            const glyphs = font.glyphs;
            if (glyphs.length !== 53) {
                console.error("Unexpected font length, skipping decryption: " + fontPath);
                return undefined;
            }
            let decryptArray = new Array(glyphs.length - 1);
            for (let i = 27; i < glyphs.length; i += 1) {
                decryptArray.push(glyphToCharMapping.get(glyphs.get(i).path.toPathData()));
            }
            for (let i = 1; i < 27; i += 1) {
                decryptArray.push(glyphToCharMapping.get(glyphs.get(i).path.toPathData()));
            }
            return decryptArray.join('');
        }

        let allFonts = [...this.zipObjects.keys()];
        allFonts = allFonts.filter(a => a.startsWith("OEBPS/Fonts/"));
        const decompressedFonts = new Map()
        for (let path of allFonts.values()) {
            decompressedFonts.set(path.slice(12, -6), await handleUnknownFont(path))
        }
        console.log(decompressedFonts);
        return decompressedFonts;
    }

    cleanChrysanthemumGarden(css) {
        let decryptMap = this.getDecryptForFonts()

        let mutator = async function (dom, zipObjectName) {
            let decrypt = (clear, selector) => {
                let crypt = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
                let decryptTable = new Map();
                for(let i = 0; i < crypt.length; ++i) {
                    decryptTable.set(crypt[i], clear[i]);
                }
                let decryptChar = (c) => decryptTable.get(c) ?? c;
                let decryptString = (cypherText) => cypherText.split("").map(c => decryptChar(c)).join("");
                for(let e of dom.querySelectorAll(selector)) {
                    e.removeAttribute("style");
                    e.textContent = decryptString(e.textContent);
                    console.log("(" + selector + ")" + e.textContent);
                }
            }

            for (let [fontName, decryptedFont] of await decryptMap) {
                decrypt(decryptedFont, "span[style*='" + fontName + "']");
            }

            decrypt("tonquerzlawicvfjpsyhgdmkbxJKABRUDQZCTHFVLIWNEYPSXGOM", "span.jum");
            decrypt("qVTPNEAHbykpxiYtlWdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='ZxXoTeIptL']");
            decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='ijqXQijeiD']");
            decrypt("dTKbCMwpkGWJrJOUiFVesPoXRfQSmuvqglEyDBLnzIYHAZcaxthN", "span[style*='WTKNOkuWha']");
            decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='rnlfJtfRCW']");
            decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='LPJMfkmHKG']");

            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='PWJEddcfVv']");
            decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='ofcUGYMWCy']");
            decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='hffmcMyCbf']");
            decrypt("upTZvvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='ktlmWRazmy']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='UxneBYgsjE']");
            decrypt("uZcQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='XMgbgIppHk']");
            decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='lqagMDCZsf']");
            
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='UTBCOGYVcD']");
            decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQImshtYdWMVrecxz", "span[style*='neTnLsdxBa']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='LQrKfqvDvK']");
            decrypt("YuZqUFnHITMGlebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='qmmADVPJyD']");
            decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='SGBznXcdPC']");
            decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='FnKeibFQhj']");
            decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='IXiXwzoevW']");
            decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='EvSWqkjBYz']");
            decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='hJrIMhiLIW']");

            decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='SEhBEutKiF']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtKPXTLEUjOfzGqyIlu", "span[style*='yqYCWpzUCb']");
            decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='XteTTFfBwp']");
            decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='XAGRhgiWCi']");
            decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='SAOyHmauIh']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='riwhyYaCJZ']");
            decrypt("wZkprtAulnqVFOfcvSPaDTMYdXymNQsGUILJWBiebxhEoCgjRKHz", "span[style*='obYashdtJI']");
            decrypt("PwzuNiaQBycMxhzfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='lOFLTaIJJX']");
            decrypt("PoEHTVZptQiJXjvdMUqhAfCxSuLNksIrFykbWwGoezDRlYamcgnB", "span[style*='JelXiZWjqn']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='fkIbKbXagm']");

            decrypt("VROtYexfAGoarQSWZcuCypvNMljilUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='qdmzgWVFHN']");
            decrypt("pbqUHJZxnMOjQtAuEyoemXliIPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='FZaOyZdeRR']");
            decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='pqeNICVeYY']");
            decrypt("qBCDbvnRtgEZPYaNmJGUlcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='SFZergSQdR']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='tFQOgrCLXY']");
            decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='MNBRlrkiJZ']");
            decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='PeJqMdmbmg']");
            decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='UokbKmPUVp']");
            decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='ezkyzoAbFA']");
            decrypt("WmydfBRPVIODTuxMEtYFqeQSzcjnKsXwapCkoUJZAvlGhLiNgbHr", "span[style*='HGQJysWqTs']");
            decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='rMPWDRxgHG']");

			decrypt("icHNSUwesAGBaCnZYgQVkdjbeWIPXfpDyJtForhvMzuKTqRlxOLm", "span[style*='bvEEthIsQN']");
			decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='EXvmBtYero']");
			decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='jLITCzXuHE']");
			decrypt("ERzndSqFrxuDMNtkVyOYfeTjcIJPaHwhovGKCgQZbWLAmBpsXiUl", "span[style*='LLlVMCxDmi']");
			decrypt("xPUhYNEyqXpjClKvZLJwFHWukfRnIdcVODAgrzQMtaBimbGoeTsS", "span[style*='LXRYsUabLi']");
			decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='tempdGoNKG']");
			decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXjbmrWtoVyHlM", "span[style*='twBiVBYzHD']");
			decrypt("EdmCAkeowsNOfGJKbMgTitzIUJLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='UZPvIjLhrA']");
			decrypt("kxWYnNJzIrCuoSHAeEBVTFQfaRyhMDwgmXdPZpOGUnLiKvtscjql", "span[style*='KTueDeyFJz']");
			decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='VfhIGwDqiv']");
			decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='FZaOyZdeRR']");
			decrypt("TLkrzWIdXhBpqmDytFvMJQAngUacfVbPHijlRYCusZoONKEGSexw", "span[style*='aBlnHoVyKJ']");
			decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='cSNnlFjStm']");
			decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='EjUwPEOFVm']");
			decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='gxlbCbioBG']");
			decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='MFDvucCdUp']");
			decrypt("PwyUBVTYqAXxZMfEjrSeDazCkwoivHJbKltNdLOhupgImQscnFRG", "span[style*='MKZDvaxkcf']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='RgHsxMIuJr']");
			decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='RIdELIilkj']");
			decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='rnUsFAZIoi']");
			decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='XgFmlXGwXh']");

            decrypt("lMiDtBGoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='Degoefaiuy']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='EsmkhjcGTx']");
            decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='JYCwWuItpK']");
            decrypt("geLIkWUOrHlZdTcESQRPhpwsnGboMVuyJNjtzYXBqKDCAfmxFvia", "span[style*='LFHdpmoCtX']");
            decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='nrUGbDZxOA']");
            decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQImshtYdWMVrecxz", "span[style*='oLXxkTmMQX']");
            decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXJbmrWtoVyHlM", "span[style*='ZxafLETnpI']");

            decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='POlcPLTnhM']");
            decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='BQcYLatSHs']");
            decrypt("inDFJlbUacwvHOldxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='CxlcyRYxqg']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='UydKzzhRTw']");
            decrypt("xoymMlDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='SNpstEsWYP']");
            decrypt("EDBHyibcKYCjtFmzgVArLIRXndfPhuwvTOseZlUaoxNpGJqMWkSQ", "span[style*='rsikuNaABZ']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='yzaFbpeGUa']");

			decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='iXpTXOWYGI']");
			decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='jsdNDWemkp']");
			decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='muRQDjktod']");
			decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='sLNjyzpFun']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='UPyRYJCIZw']");
			decrypt("YuZqUFnHITMGlebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='uXOSwTSgPx']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='VFxVMHNiyK']");
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='wNznjOOtYT']");
			decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='ycYNnojOqG']");

			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='RSoYmrQIwj']");
			decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='dvsEFNaARu']");
			decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='YIpLipOQtY']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='EodGVdlrVD']");
			decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmplRhMsfUa", "span[style*='QOOWMbROXb']");
			decrypt("neLPzpigAlGXRhDkQbSJyvlwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='TXMhPjQFOO']");
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='xyYMpmrjDy']");
			decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='VdkZRxEDIa']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='XrvXnqKaqP']");

            decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='QEhATCDVqE']");

            decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='hMLHuWmifY']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='eaCWdzKiSy']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='BPFfSYocak']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='rFqBSlNmQg']");
            decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='uiFvBMKztH']");
            decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='zVUvrgnjGF']");
            decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='oopuxRZzGs']");
            decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='YJTTXEElyw']");
            decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='jKdnmmYzTH']");
            decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='xEKQbXjOoW']");

            decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='OTDqowDNJD']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='qIUlUtuNsf']");
            decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='dxRSLHKLcU']");

			decrypt("WmydfBRPVIODTuxMEtYFqeQSzcjnKsXwapCkoUJZAvlGhLiNgbHr", "span[style*='IkWxKitrrD']");
			decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='psgmQvCVyq']");
			decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='rIDsekfeAb']");
			decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='RwXmycqDuM']");
			decrypt("ERzndSqFrxuDMNtkVyOYfeTjcIJPaHwhovGKCgQZbWLAmBpsXiUl", "span[style*='WyQkYVjbMG']");

            decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='AaaWpuDsFO']");
            decrypt("qVTPNEAHbykpxiYtlWdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='aqkKEZHHIL']");
            decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='eoNevgwurb']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='TzIvcRHwNP']");
            decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='UaHKTKJaLj']");
            decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='vNCJTwAHtI']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='xWVnqtcJCT']");
            decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='yYVPWuFCHj']");

            decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='kIDUpTPvCD']");
            decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='xoPNvcPQdX']");
            decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxKTnsZmPJiXEohO", "span[style*='CQySsWUNNg']");
            decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='JArjxBdbNx']");
            
            decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrllsu", "span[style*='aGnVdLlqOe']");
            decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='bYLeCyGAyw']");
            decrypt("YzklSNaconDsutOixICrJZwHeAyUEPhQBpFdTbjVmfRWqLvgXGKM", "span[style*='dMCmWigFHx']");
            decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='frTLQoITGa']");
            decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='MTCIjhSEgc']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='MtnArFkuWF']");
            decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='puZrtBgrLD']");
            decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='vTsEgzHdeB']");

			decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='KtsYVqTANh']");
			decrypt("MLTjxanXPEUrhyKpRfdNAzebCkWlovqQBgDSZuGciHmswYFOIVJt", "span[style*='mMigVYVPkh']");
			decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='MYkzWbAYqJ']");
			decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='oHUBOoUSuY']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='QWTHGRLvIs']");
			decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='WjbXCFYxIk']");
			decrypt("TLkrzWIdXhBpqmDytFvMJQAngUacfVbPHijlRYCusZoONKEGSexw", "span[style*='WKbmIlnXoB']");
			decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='YjFRqpzjbO']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='ZufVlOvExu']");

            decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='aToYvDDcst']");
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='BHKZRynEjD']");
            decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='ecPBZDLame']");
            decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='fubDGAMdrs']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='LlUbFemamT']");
            decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='NibvWtiIAf']");
            decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='SjSfEduakT']");
            decrypt("qVTPNEAHbykpxiYtlWdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='SmnZWhqOAx']");

			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='sLdJMcyDQQ']");
			decrypt("agNUKtWLPAiYezZrJpCbQuqTGMcVxHnjlSfvRImkswOEdDyBXhoF", "span[style*='dkBcnpgeJt']");
			decrypt("TLkrzWIdXhBpqmDytFvMJQAngUacfVbPHijlRYCusZoONKEGSexw", "span[style*='cdSZRpQFCO']");
			decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='SzisrFOoaT']");

            decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='ALIpIUCJMk']");
            decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='CKQpJYfVGz']");
            decrypt("yXYIoZCFJTvGrnoeuLmlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='gGsRAzxSEg']");
            decrypt("YuZqUFnHITMGlebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='hWNUQoIPWi']");
            decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='JGpfeKaLoi']");
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWejbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='SIDmzJRztK']");
            decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='WHarmuvKbg']");

			decrypt("kxWYbNJzIrCuoSHAeEBVTFQfaRyhMDwgmXdPZpOGUnLiKvtscjql", "span[style*='EKJutKehes']");
			decrypt("xBWHdOJEbXlAPhqLgtNeSoysaKGvcQIFnZrVMUuCkpDmRzifTwYj", "span[style*='elxfqZjXRa']");
			decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='GpaunVnKiX']");
			decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='LFZIIGEjZT']");
			decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='QbpSrRgIWf']");
			decrypt("xPUhYNEyqXpjClKvZLJwFHWukfRnIdcVODAgrzQMtaBimbGoeTsS", "span[style*='xXYBjQqnOB']");
			decrypt("RlquQNEITOWSUAmcJKBeYijVdgtDosPCapXzxGfLhnbvwHMZrkyF", "span[style*='ZqMJRMigmG']");

            decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='pkUlKuiMEG']");
            decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='xAniWuvZCH']");
            decrypt("NXFoTgnBCDVqEKeyxGrRlwjkhaIWdHpZsJfYMQSUAtLziOmvcubP", "span[style*='ztApfShCSk']");
            decrypt("LeGblOkQZRWdVHtXJDBPKCvhANjwEIcyrYaMmFgTsoUfSpzxqnui", "span[style*='HVqkKFQEUi']");
            decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='WeJpVkXZPy']");

			decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='XDMJrfZZtd']");
			decrypt("AiHqunvkxlfdBZNgPwFCtMIYXOEVyLczSRsaKmGhJUeTbDpjoQrW", "span[style*='DyxVyjMiPr']");
			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfsFMaisIL", "span[style*='WAEgGENQGl']");
			decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjzXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='VditYbQcZY']");
			decrypt("NXFoTgnBCDVqEKeyxGrRlwjkhaIWdHpZsJfYMQSUAtLziOmvcubP", "span[style*='xmUEQgNMDz']");
			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='rnwCJUQnAq']");
			decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='PXaIJqncph']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='sExoCVPPaw']");

            decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='FVIjXgtEsb']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='GESzRDldDz']");
            decrypt("fKTZFizMDpxBcRWINtoqSPChldAvGeHnOJugkXwLmUYyrasVQEbj", "span[style*='GshieJHwvz']");
            decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZxQvUEgzWDOjwRbxiarTIy", "span[style*='gYyzuCQCxm']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='HaaaLlaAWj']");
            decrypt("RlquQNEITOWSUAmcJKBeYijVdgtDosPCapXzxgfLhnbvwHMZrkyF", "span[style*='OFiEQvBOob']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='pTVOQGCqnJ']");
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='SAztEkpncx']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='xGZLphqtxF']");
            decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='yAxrzFRSed']");

			decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='FtQhmWcHlO']");
			decrypt("fKTZFizMDpxBcRWINtoqSPChldAvGeHnOJugkXwLmUYyrasVQEbj", "span[style*='mNDrOMRoyK']");
			decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='OeEgxHEDTY']");
			decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='psxLlxvDlG']");

            decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='HjvKbDCsDH']");
            decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='zqPFkcmlDB']");

            decrypt("AiHqunvkxlfdBZNgPwFCtMIYXOEVyLczSRsaKmGhJUeTbDpJoQrW", "span[style*='vxtznwaSqm']");
            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='JHQBMyeLrw']");
            decrypt("TLkrzWIdXhBpqmDytFvMJQAngUaCfVbPHijlRYCusZoONKEGSexw", "span[style*='YqCuBwtOTL']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='PDoQPQnKrK']");
            decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='pYQzZYzhvO']");
            decrypt("RlquQNEITOWSUAmcJKBeYijVdgtDosPCapXzxGfLhnbvwHMZrkyF", "span[style*='bSklgZaayS']");
            decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='zqPFkcmlDB']");
            decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIjlq", "span[style*='HjvKbDCsDH']");

            decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnlyLEMRONoAkfFT", "span[style*='xggDezWQIA']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='jCCblwrbDy']");
            decrypt("PoEHTVZptQiLXjydMUqhAfCxSuLNksIrFyKbWwGOezDRlYamcgnB", "span[style*='KuKqAgrObF']");
            decrypt("EDBHyibcKYcjtFmzgVArLIRXndfPhuwvTOseZlUaoxNpGJqMWkSQ", "span[style*='TyYpNlHGqQ']");
            decrypt("agNUKtWLPAiYezZrJpCbQuqTGMcVxHnjlSfvRImkswOEdDyBXhoF", "span[style*='bOAsAnIqgm']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='fYhOhxLutT']");
            decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='JhSNQSznhI']");
            decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='vldYYCYsCO']");
            decrypt("cqaYjtiIAXehDVgUGCBfPsTJNELzZwyHnWRSlMudokFpQvmKrObx", "span[style*='xMXYGAdONu']");

            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='agiYJLaNhO']");
            decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='DzljzVWfYC']");
            decrypt("WmydfBRPVIODTuxMEtYFqeQSzcjnKsXwapCkoUJZAvlGhLiNgbHr", "span[style*='HcJqBFtyNm']");
            decrypt("qVTPNEAHbykpxiYtlWdOzUHnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='jawWRTCocy']");
            decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='NnlpXLPYsJ']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='pinxYloNte']");
            decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='QTJYYDvgYZ']");
            decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='tHOGSBvGvH']");

            decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='FZzvJXfXjM']");
            decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='GglixuNUPp']");
            decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='QmczwfIsfD']");
            decrypt("EDBHyibcKYCjtFmzgVArLIRXndfPhuwvTOseZlUaoxNpGJqMWkSQ", "span[style*='tilkxaDAKV']");

			decrypt("neLPzpigAIGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='MndHoeoNXw']");
			decrypt("YuZqUFnHITMGIebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='CaJKmBdaKs']");
			decrypt("XUQvNfzGwdOAcRMIWhYbTIBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='jhmrPPEXzD']");
			decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRHXeQoIyTOciJMYnm", "span[style*='hKxrATSQzp']");
			decrypt("eGzIEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='eaYyCqqnRV']");
			
			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRIMFKGXTWPHoYcksed", "span[style*='ANzjBkhFTL']");
			decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizITKgZXfS", "span[style*='HVWHhFmqJA']");
			decrypt("PoEHTVZptQiJXjvdMUqhAfCxSuLNksIrFyKbWwGOezDRIYamcgnB", "span[style*='kvMbymWAJF']");
			decrypt("fKTZFizMDpxBcRWINtoqSPChIdAvGeHnOJugkXwLmUYyrasVQEbj", "span[style*='PdUReCkDhZ']");
			decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORICaG", "span[style*='XmgkMOawNQ']");
			decrypt("icHNSUwesAGBaCnZYgQVkdjbEWIPXfpDyJtForhvMzuKTqRIxOLm", "span[style*='ZvwzuFmBxU']");
			
			decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='cIiwXRwbyF']");
			decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='DZuquTLkhA']");
			decrypt("MLTjxanXPEUrhyKpRfdNAzebCkWlovqQBgDSZuGciHmswYFOIVJt", "span[style*='jNXhwpQOUD']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='liHMjOzgEt']");
			decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='mEQBzoqEdA']");
			decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='nqoSEJiTnP']");
			decrypt("AiHqunvkxlfdBZNgPwFCtMIYXOEVyLczSRsaKmGhJUeTbDpjoQrW", "span[style*='UmwceiuzEG']");
			decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhMsfUa", "span[style*='xgWPHuDYTz']");
			decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='xuzxOzMMPC']");
			decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='YbnwEjAxjo']");
			
			decrypt("XUQvNfzGwdOAcRMIWhYbTlBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='QBogmBPYKc']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='rxdxfUoCvI']");
			decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='tJtukNhqic']");
			decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='TtVtZAXhqK']");
			decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='awFGXXLiKQ']");
			decrypt("NszhwBZXSOtiqdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='HdZYlBhwTz']");
			decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='uCigUAdiXC']");
			decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='VcmTjHAEzo']");
			decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQImshtYdWMVrecxz", "span[style*='wKGsORdmfX']");
			decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='zbjwVepUeE']");
			
			decrypt("YzklSNaconDsutOixICrJZwHeAyUEPhQBpFdTbjVmfRWqLvgXGKM", "span[style*='BSQNcDVreW']");
			decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='kkCdjdLdVO']");
			decrypt("EDBHyibcKYCjtFmzgVArLIRXndfPhuwvTOseZlUaoxNpGJqMWkSQ", "span[style*='pvQgkvDQZl']");
			decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCxjR", "span[style*='rSCpDiHMur']");
			decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='vhJJwhXnAr']");
			decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWltZVSnmSvw", "span[style*='XtRNtoBihX']");
			
			decrypt("PoEHTVZptQiJXjvdMUqhAfCxSuLNksIrFyKbWwGOezDRlYamcgnB", "span[style*='AjJWUchvZb']");
			decrypt("agNUKtWLPAiYezZrJpCbQuqTGMcVxHnjlSfvRImkswOEdDyBXhoF", "span[style*='dpsfRuXuOz']");
			decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='IIHVIzufsN']");
			decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='lbcCjTYgFi']");
			decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='ZeoadYBNPg']");
			
			decrypt("HqOPjeAglRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='phrolpjgzh']");
			decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='bjRPbhCkQt']");
			decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='dwHwlXfoUt']");
			decrypt("fKTZFizMDpxBcRWINtoqSPChldAvGeHnOJugkXwLmUYyrasVQEbj", "span[style*='ifxtbeNIIH']");
			decrypt("qVTPNEAHbykpxiYtlWdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='lPhbSfJPTC']");
			decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='RfJkarqqHC']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='UuQicbLMrp']");
			decrypt("HFETmJAhKPnDOYjBwyxuXatiZRovpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='wXqQRrHdLX']");
			decrypt("DwChjXeaLTrHMBxEzfsuPkmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='yVywnHJxAt']");
			
			decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='FGuoOIMjUB']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='HeSWchDckg']");
			decrypt("xBWHdOJEbXlAPhqLgtNeSoysaKGvcQIFnZrVMUuCkpDmRzifTwYj", "span[style*='jgOPAaiAnu']");
			decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='eJihQnNckS']");
			decrypt("LeGblOkQZRWdVHtXJDBPKCvhANjwEIcyrYaMmFgTsoUfSpzxqnui", "span[style*='fhvNaAPXeC']");
			decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='IrxyYFkspo']");
			decrypt("cqaYjtiIAXehDVgUGCBfPsTJNELzZwyHnWRSlMudokFpQvmKrObx", "span[style*='oGVTClDatW']");
			decrypt("CmWkeQxEgfFYuAxHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='PiwTEDJwoG']");
			decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='qGCUfnabrY']");
			decrypt("geLIkWUOrHlZdTcESQRPhpwsnGboMVuyJNjtzYXBqKDCAfmxFvia", "span[style*='sBLhRAgBhd']");
			decrypt("icHNSUwesAGBaCnZYgQVkdjbEWIPXfpDyJtForhvMzuKTqRlxOLm", "span[style*='sbyWLogLBT']");
			decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='zLkVQwzxjT']");
			
			decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='DseKNEmJbA']");
			decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='FwNWdNCnyq']");
			decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='GiRSuKsSOI']");
			decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='ucEjJeMRiv']");

			decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='CnBAiPJRfi']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='DugpSZgbmt']");
			decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='Ezrbsbtjeo']");
			decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='fFEYydgEHE']");
			decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='fPtbPlSKat']");
			decrypt("XUQvNfzGwdOAcRMIWhYbTlBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='gmglHlqSjO']");
			decrypt("ERzndSqFrxuDMNtkVyOYfeTjcIJPaHwhovGKCgQZvWLAmBpsXiUl", "span[style*='IRuvBcurSL']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='ONHEpRWpjx']");
			decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='snYvkaczbb']");
			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUCRlMFKGXTWPHoYcksed", "span[style*='UtwLsEkAoa']");

            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='kNeNviHRDK']");
            decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='pzyhjUqAhr']");
            decrypt("NszhwBZXSOtiqdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='snptGZGmWv']");
            decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='TWFlJryqfq']");
            decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjzXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='VjKVnfjjQs']");
            decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='xIzNNlPBQB']");
            decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='ZRWYeJdFBQ']");

            decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='bmHCuBanCi']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkXM", "span[style*='bReURvlGqA']");
            decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='cnXrCfzxlb']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='JglZgGASFQ']");
            decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='JoEagppXYy']");
            decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='MXrUNfbJUX']");
            decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='NLtxmSaHGQ']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='NxgEovlkgj']");
            decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='orYlNCdzzI']");
            decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='tTeCCvwvcT']");
            decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='UxLvNizkFH']");
            decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='VcRvSpCYUO']");
            decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='yVAETkZivA']");

			decrypt("hrGNJQxmbjuUDROFWpHSLcnBPIvkVYtAadeoCwqyEMizITKgZXfS", "span[style*='MrsDKXcJRu']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='bjcFJkgyHn']");
			decrypt("dTKbCMwpkGWJrjOUiFVesPoXRfQSmuvqglEyDBLnzIYHAZcawthN", "span[style*='BMmaSMOgik']");
			decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='HAzpEZytyj']");
			decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='JBFKtbeAMI']");
			decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='lKTYOCkvjn']");
			decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQlmshtYdWMVrecxz", "span[style*='rNGLQMYJCb']");
			decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='TBbQBejfVZ']");
			decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='TBZnNCLGOV']");
			decrypt("XUQvNfzGwdOAcRMIWhYbTlBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='xfHJfsTsoc']");
			decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='yndLSmPuYx']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDkpxanSQ2echMsYgPJCE4FUONk", "span[style*='mkZnmyCyTK']");

            decrypt("qVTPNEAHbykpxiYtlWdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='aKlRoedXcP']");
            decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='aqLqFxBflS']");
            decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='hxqlVVFpyT']");
            decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUlwvHMpnzPKdVGhjbAgBxmyr", "span[style*='iYqiwlSeuG']");
            decrypt("MLTjxanXPEUrhyKpRfdNAzebCkWlovqQBgDSZuGciHmswYFOIVJt", "span[style*='JpBZljwDbv']");
            decrypt("TsalRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='pKyovMqMus']");
            decrypt("pbqUHJZxnMOjQtAuEyoemXlilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='PTDTpMVgOB']");
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='XBYKeyjZbv']");
            decrypt("HfdFkPlmYisAcWLtKlCaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='ZkWZuXAqpJ']");

            decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNuIPZoHgbksMpVQCn", "span[style*='AJQxhFSsyY']");
            decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORICaG", "span[style*='cYLFBesgtm']");
            decrypt("qVTPNEAHbykpxiYt1WdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='EvxYUCsrBh']");
            decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrlIsu", "span[style*='JKAQJDTTcW']");
            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAlJbxvwjn", "span[style*='kLuxSfQVuD']");
            decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='seOIErwNvE']");
            decrypt("IMiDtBgoaKXzlhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='SjPYycoRPN']");
            decrypt("geLlkWUOrHlZdTcESQRPhpwsnGboMVuyJNjtzYXBqKDCAfmxFvia", "span[style*='WsaANMhmKK']");

			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='bcjASbYege']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='UqhgPnhjoJ']");
			decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='RXighhgtEm']");
			decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='YFIDAUUcsh']");
			decrypt("PoEHTVZptQiJXjvdMUqhAfCxSuLNksIrFyKbWwGOezDRlYamcgnB", "span[style*='zyGsynabTv']");
			decrypt("YuZqUFnHITMGlebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='HwFavpPkGw']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='kTWyBzbIGp']");
			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='HGnctjVycO']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='DjHaXTcamf']");
			decrypt("vBIiyHArRYXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='japuRgDLGg']");
			decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='FjEmdZyeGP']");
			decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='OhIDWsgssM']");
			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='YhgEWanrvH']");
			decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='yUIWAjSGaX']");
			decrypt("LeGblOkQZRWdVHtXJDBPKCvhANjwEIcyrYaMmFgTsoUfSpzxqnui", "span[style*='voLivlpXvU']");
			decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='hJXXwqCjzq']");
			decrypt("TLkrzWIdXhBpqmDytFvMJQAngUacfVbPHijlRYCusZoONKEGSexw", "span[style*='gzKHRPgYPn']");
			decrypt("RlquQNEITOWSUAmcJKBeYijVdgtDosPCapXzxGfLhnbvwHMZrkyF", "span[style*='fCseyPcXHf']");
			decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='EwohrCTSaN']");
			decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='RJEjvTeXuz']");
			decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='ZSMaHrLlcF']");
			decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='FfmglDUmTV']");
			decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='EuQldfUcLS']");
			decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='PfYLzEpnPc']");
			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='EepWFhJowP']");
			decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='jZFgVUDRJD']");
			decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='JkekpqSduc']");
			decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='pYJeYIvRWN']");
			decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='NthGgQtnEU']");
			decrypt("EDBHyibcKYCjtFmzgVArLIRXndfPhuwvTOseZlUaoxNpGJqMWkSQ", "span[style*='DffpnFWsqS']");
			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='PbooOdOTMH']");
			decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='GEgdLlWzgw']");
			decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='FpbHeFETHq']");
			decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='kbPQEsWyjR']");
			decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='LfHFUNYAYX']");
			decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='QGJnmozaku']");
			decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='WxSGebjYmh']");
			decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjzXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='ncyFkyqWmI']");
			decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='uTuhlxOElD']");
			
			decrypt("VStMAakjpfRyFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='juoLtWRuzo']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='dPLwWvppra']");
			decrypt("NszhwBZXSOtiqdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='jVrAaIYHoJ']");
			decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='nVraLQYauT']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='pvVXRLazoW']");
			decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='rGCwidqqrd']");
			decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='XTGupiZUgB']");
			decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='YyDgAkiXjj']");
			
			decrypt("zBnNYbFxfkPLZZrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='AOsUOCfLsW']");
			decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='eFqUkxgIOb']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='eyZjKatIPm']");
			decrypt("zBnNYbFxfkPLZZrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='FQIiXVcWEX']");
			decrypt("MLTjxanXPEUrhyKpRfdNAzebCkWlovqQBgDSZuGciHmswYFOIVJt", "span[style*='HrVWHXobgX']");
			decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='mzTaCKWyAF']");
			decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='RzziutshiB']");
			decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='sxOltDiYfv']");
			decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='uRRcZYHydL']");

			decrypt("FGqNYQLTPUHecErxRucjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='CDIdzVFjio']");
			decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='hExpUlPJls']");
			decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='IcDBdGsoRS']");
			decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhMsfUa", "span[style*='QcpPWafgbK']");
			decrypt("icHNSUwesAGBaCnZYgQVkdjbEWIPXfpDyJtForhvMzuKTqRlxOLm", "span[style*='QfsizaxpRb']");
			decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='UINWZoCAqM']");
			decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='uJnABQOOyD']");
			decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjxXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='ZRwARyKlZU']");
			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='BJysvfWzQb']");
			decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='FUsArGlhwX']");
			decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='iTehRbpqwm']");
			decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='MNIQBoqHGl']");
			decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQImshtYdWMVrecxz", "span[style*='pCzObrjeSz']");
			decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='XSSOUMDRHy']");
			decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='xTGNOGhrXk']");
			
			decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='AMZgFZcROZ']");
			decrypt("dTKbCMwpkGWJrjOUiFVesPoXRfQSmuvqglEyDBLnzIYHAZcaxthN", "span[style*='clOJkuyOQd']");
			decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXJbmrWtoVyHlM", "span[style*='eEZWDGhWGv']");
			decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='kMVEWKJykc']");
			decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='LPBtYQvdTX']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='lrBkDeOljs']");
			decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='MumfBvywRu']");
			decrypt("kxWYbNJzIrCuoSHAeEBVTFQfaRyhMDwgmXdPZpOGUnLiKvtscjql", "span[style*='NlFSnlDZXt']");
			decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='nnAgBKwTGt']");
			decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='qdbIwxnNkU']");
			decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQImshtYdWMVrecxz", "span[style*='RwhlWIsHFJ']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='sYmBEyfbbl']");
			decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='tvOtdvXBRe']");
			decrypt("YuZqUFnHITMGlebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='uaSAzKKnqk']");
			decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='vzjDMAdYOl']");

			decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='ejAeHMBymq']");
			decrypt("vBIiyHArRYXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='AQxnIsDumE']");
			decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='iMNJeWnvUh']");
			decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='LGxJYysRIk']");
			decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='NfhCRvCnno']");
			decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCXjR", "span[style*='pQcWPzpaVl']");
			decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='TspgyfrGBi']");
			
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='alvgmnbkmf']");
			decrypt("TLkrzWIdXhBpqmDytFvMJQAngUacfVbPHijlRYCusZoONKEGSexw", "span[style*='IrKdWsGRMO']");
			decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXJbmrWtoVyHlM", "span[style*='ISjDhNEHac']");
			decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='QJMcnStxOB']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='qwZRlsggGD']");
			decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='rnpCDEwkGW']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='ukmIQftduw']");
			decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='VaIoHvGJtg']");
			decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='xGnoFXNBVC']");
			decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='yYdxlleKWe']");
			
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='cIUfMFFovl']");
			decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='cnEeriPySJ']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='DFkGtSHboi']");
			decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='DoWzakOILN']");
			decrypt("mLPWMFVSlnDUzBxivJhoOwICZEpgAGqsyQfrjXabedkHNkTRYtuc", "span[style*='DPtCqulgjb']");
			decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='dpUUjBTAqi']");
			decrypt("kxWYbNJzIrCuoSHAeEBVTFQfaRyhMDwgmXdPZpOGUnLiKvtscjql", "span[style*='fPJhilrnny']");
			decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='fZMgpcOrAG']");
			decrypt("AiHqunvkxlfdBZNgPwFCtMIYXOEVyLczSRsaKmGhJUeTbDpjoQrW", "span[style*='jfpBCKIPwR']");
			decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='mbyNtGXiVh']");
			decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHTtbqQAahk", "span[style*='mGShNdJMaZ']");
			decrypt("gXGiFupUyItQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAlJbxvwjn", "span[style*='PYXuVrtBgv']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='rrJDvEJrWD']");
			decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='SBGcyxzNBL']");
			decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzpPaebFDcZoRHSwUrNfqKQ", "span[style*='shbWMmNRjw']");
			decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='SPGpJmyjJv']");
			decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='TFxnzfpNdH']");
			decrypt("EmlhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLIHiWfbUjdZ", "span[style*='TqFGPUefId']");
			decrypt("iDZOLYCJEXRfQsucWoTIkqeFtNSaUlwvHMpnzPKdVGhjbAgBxmyr", "span[style*='VIauEWgwXz']");
			decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDlaLiEFTNuIPZoHgbKsMpVQCn", "span[style*='VimmFshIRl']");
			decrypt("RIquQNElTOWSUAmcJKBeYijVdgtDoPsCapXzxGfLhnbvwHMZrkyF", "span[style*='VTjbuHWYYu']");
			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='xgLZBJpJAw']");
			decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='yIukOyvQdF']");

			decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='EGNasdSKwx']");
			decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhMsfUa", "span[style*='enpobLqKJb']");
			decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='hTIDISAgYt']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='LuRMsKgrDe']");
			decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='ousqfBCdIC']");
			decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='TYaugVmfpC']");
			decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='vlvoUaBTIB']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='ZAcOyshiXU']");
			decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='GtIOlxSDNU']");
			decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='ibVgYblugQ']");
			decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='lYmKMWwXpv']");
			decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='MVzzlGcGaj']");
			decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='tnEpWDMjDH']");
			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='UfWsCMqhWl']");
			decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXJbmrWtoVyHlM", "span[style*='XhHYNwKOZL']");

            decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='bGFbLoItHV']");
            decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='dcYfvTmpfN']");
            decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='gxJRomHUOl']");
            decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='OsyTlCGBvi']");
            decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='qInBqzIvrL']");
            decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='wZHhOEDAoM']");

			decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='DLNVsHfPKZ']");
			decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCFRGXeQolyTOciJMYnm", "span[style*='EUKKgQkEQq']");
			decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='qEEnuVQTre']");
			decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='YeyKNgMzwb']");

            decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='EZcSoGEMiR']");
            decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='hfDMmlRJqL']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='hSnXqfZUue']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='okgSzSSzQi']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='ywmBAihBbm']");

            decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='cEywmbTqDB']");
            decrypt("gjkChAdlBJYOVIxTXnisWLvmyEMtuGzPpaebFDcZoRHSwUrNfqKQ", "span[style*='ZufvcqapRI']");
            decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='YZhIyDIBCR']");
            decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='YvPJocLSiJ']");
            decrypt("gXgiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='XAtFBRYSPv']");
            decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='uttlRpyQqm']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='TPgaxZlNUF']");
            decrypt("wZkprtAulnqVFOfcvSPaDTMYdxymNQsGUILJWBiebxhEoCgjRKHz", "span[style*='TNrFpJYfpb']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='RNjJeVoFRX']");
            decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='NRKdGsMXqz']");
            decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='MCbUcGvgNd']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='KsLnrlSDmU']");
            decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='eWWvlItOgw']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkXM", "span[style*='EqBQsyjAkF']");

            decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='IIjiYtvvof']");
            decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='kCpLayiTNj']");
            decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='kzkLbBUFeR']");
            decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='SpjgLmKunX']");
            decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='SwzfWWErOQ']");
            decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='TEewvuhkhN']");
            decrypt("YxklSNaconDsutOixICrJZwHeAyUEPhQBpFdTbjVmfRwqLvgXGKM", "span[style*='OPKyjLATvR']");
            decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='WSBGAAnPFU']");
            decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='CYTrrEwFwT']");

            decrypt("RlquQNEITOWSUAmcJKBeYijVdgtDosPCapXzxGfLhnbvwHMZrkyF", "span[style*='ClkMkHDYMQ']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlfBCevhHSAEDIpnoGTukibyxamJU", "span[style*='cZCOfOioXw']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='DRdqobfMAp']");
            decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='JbcxFeKwNr']");
            decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='OaDSpGkfXl']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='pbWEDoTvXK']");
            decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='RvmcoUMLSJ']");
            decrypt("DwChjXeaLTrHMBxEzfsuPKmWcjqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='zTMxNuHtWW']");
            decrypt("wGEnejTOVNDQxFqiHgbWZtLydjlcSouXBPKrYvzACkmplRhMsfUa", "span[style*='CsOenNavOD']");
            decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='hPEZazwLbq']");
            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='iKIlSZozCU']");
            decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='LEEaEUACWi']");
            decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='QTkGMKMNis']");
            decrypt("dTKbCMwpkGWJrjOUiFVesPoXRfQSmuvqglEyDBLnzIYHAZcaxthN", "span[style*='yljVjwreth']");
            decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='bxYZYWAkss']");
            decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='jcjxdWyznV']");
            decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='rrCINBtEss']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='TLMhrEfbrV']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkXM", "span[style*='fmMHCjInsh']");
            decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='hRPtnhGSXO']");
            decrypt("xPUhYNEyqXpjClKvZLJwFHWukfRnIdcVODAgrzQMtaBimbGoeTsS", "span[style*='PVOpoRCMSr']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='vOVAzBClRx']");
            decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhMsfUa", "span[style*='wCKcmmbmAr']");
            decrypt("PwzuNiaQBycMxhZfelTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='yONEBiiCRm']");
            decrypt("HwSjBkqPuabFCNgvlXGiEDpZJURnfKoLATOyQImshtYdWMVrecxz", "span[style*='fudqwliLjE']");
            decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlmFKGXTWPHoYcksed", "span[style*='iqzLxBfCpY']");
            decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='RiPNQnwvFF']");
            decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='uGDnnlyNIV']");

            decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='BEvDERdjQu']");
            decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjzXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='CkqVsbqcOM']");
            decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='kMwjzUtVIh']");
            decrypt("yXUOpZCFJTvGrnoeuLMlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='ULMyPOXwLI']");
            decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='xTaHduEiQz']");
            decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='yuzXNEnNUB']");
            decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhMsfUa", "span[style*='ZsVuUIEfes']");

            decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='idUUsjsnjQ']");
            decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='jTyUTrgCnu']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='MjsyeDdbOd']");
            decrypt("dTKbCMwpkGWJrjOUiFVesPoXRfQSmuvqglEyDBLnZIYHAZcaxthN", "span[style*='PAprchfRCk']");
            decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='ruHGymMIWT']");
            decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='TBYjEHAIQP']");
            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='ymfNBNYdQt']");
            decrypt("XUQvNfzGwdOAcRMIWhYbTlBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='yVAUTXmqcl']");

            decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCXjR", "span[style*='AXDurpNEAn']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkXM", "span[style*='bnmyfUhmhQ']");
            decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='BuFflQVTFp']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='cXJZebSxhr']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='dopeZmmoAT']");
            decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='IbkwxZsVNj']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='nvhhlNeUyR']");
            decrypt("wZkprtAulnqVFOfcvSPaDTMYdXymNQsGUILJWBiebxhEoCgjRKHz", "span[style*='RqdoohxIiT']");
            decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='UTJpduJgZj']");

            decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='nEcuCEOIcI']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='NimOjJxoWP']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='sGdXsEBpGR']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='SodstvjFyd']");
            decrypt("RlquQNEITOWSUAmcJKBeYijVdgtDosPCapXzxGfLhnbvwHMZrkyF", "span[style*='WPQSZdUIYt']");
            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='XTawgQGAWW']");

            decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='aAffVnrzXD']");
            decrypt("NszhwBZXSOtiQdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='GymGrGlBco']");
            decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='INwLyngWNq']");
            decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='OeNeEqGiZq']");
            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='UJciWYaxPm']");
            decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='XfuDxbCbRe']");
            decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='XtdctAnsye']");

            decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxyLZkpl", "span[style*='cgMzUELiER']");
            decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGinabD", "span[style*='hnAbElQJmu']");
            decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='kdmfiifpcg']");
            decrypt("HqOpjeAgIRWtQFyaKBCVGnzrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='ktUZRsMYmx']");
            decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='LjxaYmuMri']");
            decrypt("LAnBhRjcwgZbvlCrNmQTqKXyFDPdJVEGzaWYIikSoetHUfxsuMpO", "span[style*='LvFfZGyoPM']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='pBpZfDqrbN']");
            decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='QEiuRLGNge']");
            decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='UmMnXyDEkG']");
            decrypt("cqaYjtiIAXehDVgUGCBfPsTJNELzZwyHnWRSlMudokFpQvmKrObx", "span[style*='YELcTsUnHt']");
            decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='ZgzGrgdcsm']");
            decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='zxuIiBdkVF']");

            decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='CLlZAgCKRv']");
            decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='FfJfnFqLkp']");
            decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='GUTvalplnN']");
            decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDKpxanSQlechMsYgPJCEIFUONk", "span[style*='GZbsNyqWgR']");
            decrypt("LeGblOkQZRWdVHtXJDBPKCvhANjwEIcyrYaMmFgTsoUfSpzxqnui", "span[style*='HqIbiQqBKV']");
            decrypt("FGqNYQLTPUHecErxRuCjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='jbmxpcXePY']");
            decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='lRSTkyFwzQ']");
            decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='VREJPvHIhT']");
            decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='YNteLJSWHb']");
            decrypt("eCPpVmfshBHdcASJFquMKNLlYtnoGkZXQvUEgzWDOjwRbxiarTIy", "span[style*='zxuIiBdkVF']");

            decrypt("LzRsNxDJpbYSdGhcXuCgoQnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='cUVFPbPrTZ']");
            decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhmsfUa", "span[style*='gMkUOsaBOU']");
            decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='MVCqYEBiyQ']");
            decrypt("vDxtzobGrXESwLWypAkZOMBYQNsdPUTVcFhnHajgRmiKfeuCIJlq", "span[style*='nwTsJTMnaR']");
            decrypt("dTKbCMwpkGWJrjOUiFVesPoXRfQSmuvqglEyDBLnZIYHAZcaxthN", "span[style*='OKbPxHXGoT']");
            decrypt("xBWHdOJEbXlAPhqLgtNeSoysaKGvcQIFnZrVMUuCkpDmRzifTwYj", "span[style*='yVcOROnSAQ']");

            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='aAHjYlagVK']");
            decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='aDLhCJJwWb']");
            decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='eaVeowUktJ']");
            decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='hPdVEmsxaL']");
            decrypt("TsalRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='RWPDxQdEmi']");
            decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUVRlMFKGXTWPHoYcksed", "span[style*='TFmwSYxkxE']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkxM", "span[style*='TNLOCcqDdL']");
            decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='UFaEWcmhtS']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='XQCWbfsXwk']");

            decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='dEjBpbdjEF']");
            decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='DREuxTWEyQ']");
            decrypt("ERzndSqFrxuDMNtkVyOYfeTjcIJPaHwhovGKCgQZbWLAmBpsXiUl", "span[style*='gNRvwnIbDT']");
            decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='JRrIUIjUxf']");
            decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='lDIuYJGBGW']");
            decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='mJgVUXoyyW']");
            decrypt("agNUKtWLPAiYezZrJpCbQuqTGMcVxHnjlSfvRimkswOEdDyBXhoF", "span[style*='nRlHTvKGex']");
            decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='QTlYZxsqHh']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='rdwJtIdWoq']");
            decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaliEFTNulPZoHgbksMpVQCn", "span[style*='stnOcsEyqz']");
            decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='ulGYXiMKSh']");
            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='xMwznzYahG']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoaImpMYiUkL", "span[style*='XQCWbfsXwk']");
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='zApfmxSrlQ']");

            decrypt("iDZOLYCJEXRfQsucWoTlkqeFtNSaUIwvHMpnzPKdVGhjbAgBxmyr", "span[style*='EfeKubnHyj']");
            decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='juXpRcvrRA']");
            decrypt("vBIiyHArRyXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='QZpZjNQUaE']");
            decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='ycjIoumbyn']");

            decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='CmVofOoVTU']");
            decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjxXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='fMhMAzkigU']");
            decrypt("YzklSNaconDsutOixICrJZwHeAyUEPhQBpFdTbjVmfRWqLvgXGKM", "span[style*='gVBgxmsqDB']");
            decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='RJBeCqserb']");

            decrypt("TsaIRfGZnYhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='aPqUDYiXqg']");
            decrypt("RWOVtgzYjNFXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='AWggbZhLlE']");
            decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='DQpClQAktu']");
            decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='FocLiWvPDo']");
            decrypt("MxaoiDLZktbgBpfmuGqXdJwsSCOYryHVRUKlzNvAnTjIWchPQFeE", "span[style*='iKBKfmoKdX']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='KcbPVmSCiG']");
            decrypt("eOqaECAymwKprhdcvWNLTxUHgnVXfSoMjPJkzQbDtBFGizYrIlsu", "span[style*='kesmVWzqvb']");
            decrypt("MLTjxanXPEUrhyKpRfdNAzebCkWlovqQBgDSZuGciHmswYFOIVJt", "span[style*='KmrRzqfENu']");
            decrypt("UaAfIxLRXihODSjcBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='ptAOsdXOuv']");

            decrypt("NszhwBZXSOtiqdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='EtnzGUAeMk']");
            decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='HQZJawIrVm']");
            decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='KxQLEwSkjY']");
			decrypt("xvlNyZqJuzshckbdajUWmEKGCrRPOwTHIBAFYLnpfeMSDXQVtgio", "span[style*='wIQFfbwdmB']");
			
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='bSRoIHeQjO']");
			decrypt("icHNSUwesAGBaCnZYgQVkdjbEWIPXfpDyJtForhvMzuKTqRIxOLm", "span[style*='iURpuOalyX']");
			decrypt("IMiDtBgoaKXzlhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='jnJSUORXzg']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDkpxanSQlechMsYgPJCEIFUONk", "span[style*='LeTyvdOOtt']");
			decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='lJeUnPtvWU']");
			decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='lWWzVtbgko']");
			decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='NRKygqPTMI']");
			decrypt("inDFJlbUacwvHOIdxushAoLVMZCSeYjPXkzNtQRfyqTrpWGgmEBK", "span[style*='PjOsCYNpCi']");

			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='BuKktLFsBD']");
			decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='duAUOdvNnz']");
			decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDqLyOKtTNIcnz", "span[style*='DyNyTbCjLS']");
			decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='ecUgNtqmOX']");
			decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='GOVgkvmwLW']");
			decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='hSOkEzrUdy']");
			decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='KFXtkDrlcW']");
			decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='mehEJLSwzT']");
			decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='MtDPRDpOIA']");
			decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxKTnsZmPJiXEohO", "span[style*='nLGwZrEHfd']");
			decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDkpxanSQlechMsYgPJCEIFUONk", "span[style*='NsWENITftu']");
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='NySEndUEbl']");
			decrypt("vBIiyHArRYXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='oUgtZTGozh']");
			decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='pawlHhwceR']");
			decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='PMpvaSkHHz']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='qilPkOEdXS']");
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='sgZOXjHoNM']");
			decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='sqwHKxlHQE']");
			decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXJbmrWtoVyHlM", "span[style*='sZNFisYMcn']");
			decrypt("XUQvNfzGwdOAcRMIWhYbTlBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='vpfPPnlQvy']");

			decrypt("qVTPNEAHbykpxiYtlWdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='EqPbCKLsmM']");
			decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='OXIIxFsEnm']");
			decrypt("XUQvNfzGwdOAcRMIWhYbTlBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='vwOBulTBEp']");
			decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='XcosHpGJmq']");
			decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='FvGvkqwhRk']");
			decrypt("WmydfBRPVIODTuxMEtYFqeQSzcjnKsXwapCkoUJZAvlGhLiNgbHr", "span[style*='LYRHSwklhH']");
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='mpXRnyoxQV']");
			decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='RmjsbWbWXC']");
			decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='uMRmspnMBt']");

            decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='BxebgogZoh']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='QYxGIFNaLm']");
            decrypt("neLPzpigAlGXRhDkQbSJyvIwVjYxfoOMcqsENrUWtmTFCZHaBduK", "span[style*='xWtcTuvAgk']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkXM", "span[style*='yjcHUCtYdl']");

            decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='cASUNDzkeM']");
            decrypt("Em4hxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='GBudnZsIiT']");
            decrypt("UaAfIxLRXihODSjvBEFJeZuGTPlWnVQzcyqrHNkmoMKCgbtsdYwp", "span[style*='IpGsiEiJrS']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='uZKaxeePfc']");

            decrypt("jweUWMzgtNpxCblFiGIOPRvBHoJXZDVmQnTLuYhdfrEcKakAsSqy", "span[style*='ceWwzJicOF']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMyiUkL", "span[style*='EyrEPPElVf']");
            decrypt("CmWkeQxEgfFYuAXHUwpVRGiMvJbBdojPalhrsSZDQLyOKtTNIcnz", "span[style*='FDthleQfFu']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='FVMKsxWkzx']");
            decrypt("NXFoTgnBCDVqEKeyxGrRlwjkhaIWdHpZsJfYMQSUAtLziOmvcubP", "span[style*='gdwEILiJld']");
            decrypt("ELzZxnXGphkCMRFmAuBfIyvgiwjDSNtlJqaHPWObsUQreVYTKcdo", "span[style*='GkpNCxrTdN']");
            decrypt("TLkrzWIdXhBpqmDytFvMJQAngUacfVbPHijlRYCusZoONKEGSexw", "span[style*='hLxTTVAhWH']");
            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='MVdUZHsuVu']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='pqWIVrnUjF']");
            decrypt("xBWHdOJEbXlAPhqLgtNeSoysaKGvcQIFnZrVMUuCkpDmRzifTwYj", "span[style*='QzHPLBnaFe']");
            decrypt("xPUhYNEyqXpjClKvZLJwFHWukfRnIdcVODAgrzQMtaBimbGoeTsS", "span[style*='RjilITqNlY']");
            decrypt("eGzleDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='vbyTyrlzTS']");
            decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='YzEsZKndmV']");
            decrypt("ikvXhpVftrOcGCBaZxgFSwmWEjbAoLePKnTqUDMIyJdRlQuzsYNH", "span[style*='zApfmxSrlQ']");

            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='AtOBbBFuxP']");
            decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='bjUFsUPwtP']");
            decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='CWKTZodMbG']");
            decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='DjqYMOHcQT']");
            decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='jNAOQwdhme']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='MRWuegxCeM']");
            decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='nbpcUzYark']");
            decrypt("ErZUfzIKaAPqYwLFCVdeOQJkSTHxuGlphobMgNcsXjinDWmByRtv", "span[style*='nREgDyyQqU']");
            decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='XGWpELbqcp']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='yaOLunPsvt']");
            decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='ydBCriWSRM']");
            decrypt("WmydfBRPVIODTuxMEtYFqeQSzcjnKsXwapCkoUJZAvlGhLiNgbHr", "span[style*='yqlhHcVMhN']");

            decrypt("wGEnejTOVNDQxFqiHgbWZtLydJlcSouXBPKrYvzACkmpIRhMsfUa", "span[style*='EdFEOcXXjf']");
            decrypt("HFETmJAhKPnDOYjBwyxuXatiZRoVpMWvefcqzNkgQlsCdIGUbSrL", "span[style*='InSIgxwxWb']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='LzkbAkjWij']");
            decrypt("LeGblOkQZRWdVHtXJDBPKCvhANjwEIcyrYaMmFgTsoUfSpzxqnui", "span[style*='NJEyTMFftQ']");
            decrypt("AiHqunvkxlfdBZNgPwFCtMIYXOEVyLczSRsaKmGhJUeTbDpjoQrW", "span[style*='PskqRgeqPU']");
            decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCXjR", "span[style*='QNaepCiMBy']");
            decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='qSMPrYurRu']");
            decrypt("LzRsNxDJpbYSdGhcXuCgoqnFmrHEiZjyMtOfIKPATvwQBVakleWU", "span[style*='rhDqvlsoMr']");
            decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='UAPsRxNXsz']");
            decrypt("eDCzyBhMrKZJnNadoxOLtmiIvHTcPbSRYlfqukUgAGXspwVQFEWj", "span[style*='xwjDVbtxqv']");

            decrypt("NXFoTgnBCDVqEKeyxGrRlwjkhaIWdHpZsJfYMQSUAtLziOmvcubP", "span[style*='ANzXZterVN']");
            decrypt("LeGblOkQZRWdVHtXJDBPKCvhANjwEIcyrYaMmFgTsoUfSpzxqnui", "span[style*='APgtCnGDeH']");
            decrypt("YuZqUFnHITMGIebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='BlySqcmsPd']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='boqpYCMpgR']");
            decrypt("hrGNJQxmbjuUDROFWpHsLcnBPIvkVYtAadeoCwqyEMizlTKgZXfS", "span[style*='dKFPyxJBPY']");
            decrypt("xBWHdOJEbXlAPhqLgtNeSoysaKGvcQIFnZrVMUuCkpDmRzifTwYj", "span[style*='DwcJkPpPOn']");
            decrypt("yXYIoZCFJTvGrnoeuLmlgzdxjcSERPmfwKIDiNYVsWHtbBqQAahk", "span[style*='FjLQIxyVSb']");
            decrypt("vBIiyHArRYXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='gEXPkZjfHj']");
            decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='GOsVQDubcA']");
            decrypt("xPUhYNEyqXpjClKvZLJwFHWukfRnIdcVODAgrzQMtaBimbGoeTsS", "span[style*='HEIikFAihz']");
            decrypt("PwzuNiaQBycMxhZfelTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='hGBxAynfEe']");
            decrypt("fKTZFizMDpxBcRWINtoqSPChldAvGeHnOJugkXwLmUYyrasVQEbj", "span[style*='IJxBvyAaYp']");
            decrypt("zBnNYbFxfkPLZXrViQtEMSRsepyvdwJgDCmWcauGqToHKhIjUAlO", "span[style*='jOZsyVGiye']");
            decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='lgJYGqDgmP']");
            decrypt("XBPQJaTEScurUgntLhipeROoKksGzAYCWMjqFdZlwmbDHvyINVfx", "span[style*='NjzXCqpOOM']");
            decrypt("kxWYbNJzIrCuoSHAeEBVTFQfaRyhMDwgmXdPZpOGUnLiKvtscjql", "span[style*='PaiUWqoFpE']");
            decrypt("NXFoTgnBCDVqEKeyxGrRlwjkhaIWdHpZsJfYMQSUAtLziOmvcubP", "span[style*='QCBUoSvHgs']");
            decrypt("lMiDtBgoaKXzIhdLfGjQScPbTEHNemZkCxuRFUqvnJwsVyOrWYAp", "span[style*='teeWwRoLeB']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='vWoojhWxjd']");
            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='XvvxPHBelf']");

            decrypt("gXGiFupUyltQdSezsofMPVcqHLBROTmCNEYrZhaWDkKAIJbxvwjn", "span[style*='aHYQdJrbfp']");
            decrypt("XUQvNfzGwdOAcRMIWhYbTIBFSxojpnZDPCHVktKEJmuqgsyariLe", "span[style*='DPsSHLwGVX']");
            decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='jlENUDNsKc']");
            decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='mChSXGPcCn']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='rjkeYLzYmH']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='cmVraWdyro']");
            decrypt("jkTGEJOByaPzKgnCeIDimbNqMvlwpxQZdXFroVWcuhsRfUASHLtY", "span[style*='foLnsgCnsT']");
            decrypt("pbqUHJZxnMOjQtAuEyoemXIilPNcDTdazWkKgGLRhwYfBSFCVsvr", "span[style*='MRWXBTNWFq']");
            decrypt("qBCDbvnRtgEZPYaNmJGUIcdsSHFMQKhyzxpWejTVilXfowOuAkrL", "span[style*='uqCNgrfpHC']");
            decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='uYbruViYsP']");
            decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='vVneAwTeQA']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='CIXSfWojCE']");
            decrypt("NszhwBZXSOtiqdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='DWqrzxCiyf']");
            decrypt("vBIiyHArRYXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='eWMLBZhPwS']");
            decrypt("XiFDICeMQtqEvboVjuhdcOgySaNzwBJGKWrPfTAmnsRHUxYLZkpl", "span[style*='FgsWfmIgFE']");
            decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='IhxcIJeQgA']");
            decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='oFKKYgOrTH']");
            decrypt("icHNSUwesAGBaCnZYgQVkdjbEWIPXfpDyJtForhvMzuKTqRIxOLm", "span[style*='PlrklxFwJD']");
            decrypt("eGzlEDIZUgQyYPBHRqitLSXTahMOdnuvAFcxkspjoNJCfwKbVmrW", "span[style*='wuskoyrQgx']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtKPXTLEUjOfzGqyIlu", "span[style*='WyOVbFqtsn']");
            decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCxjR", "span[style*='zzQrJWaLws']");

            decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='wzModeUHBz']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='TpQORTMRyX']");
            decrypt("PwyUBVTYqAXxZMfEjrSeDazCkWoivHJbKltNdLOhupgImQscnFRG", "span[style*='IooeTUobqz']");
            decrypt("ERzndSqFrxuDMNtkVyOYfeTjcIJPaHwhovGKCgQZbWLAmBpsXiUl", "span[style*='NOUmfWriJF']");
            decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='AQfmHjTdQg']");
            decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDSphRBaFVP", "span[style*='vSjAsmUWID']");
            decrypt("qVTPNEAHbykpxiYt1WdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='MzmvTSpwOO']");
            decrypt("iKhDSORsAbqBtGNYpecfHQEwkIxJlWCmTLjFdzrPXuvVonMygUZa", "span[style*='LYuVQIsAGA']");

            decrypt("qVTPNEAHbykpxiYt1WdOzUGnsMcZXBQuSaRKICJwgFLDefrvhmjo", "span[style*='adNqxdxypW']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='CMoEbDxuiV']");
            decrypt("RIquQNElTOWSUAmcJKBeYijVdgtDoPsCapXzxGfLhnbvwHMZrkyF", "span[style*='fvJnVcQoPb']");
            decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='GVDjjBZQaP']");
            decrypt("NszhwBZXSOtiqdJRCrDgjUHaWEAQpbyklePFTuVcomGxfYvILKMn", "span[style*='jxNLRbexYM']");
            decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='KcBqIhnJSX']");
            decrypt("bEHGfOrjzDQIWKCBxXhvetgdNnJTFVuAyPscZqRSwoalmpMYiUkL", "span[style*='KqDXOLVDRn']");
            decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='orQuXopkXX']");
            decrypt("qVGZydWjAotzwmuvXfrBbTRHLiDkpxanSQ2echMsYgPJCE4FUONk", "span[style*='SwBUIBToBV']");
            decrypt("MLTjxanXPEUrhyKpRfdNAzebCkWlovqQBgDSZuGciHmswYFOIVJt", "span[style*='xitBaNCnvr']");

			decrypt("SDhCdAvmspcaFJMxRNBriZnoHeWKYgbQwVtkPXTLEUjOfzGqyIlu", "span[style*='aaqeSFqfCS']");
			decrypt("EdmCAkeowsNOfGJKbMgTitzIUjLxnrYQZXqcvuylWHDsphRBaFVP", "span[style*='AYaqPfMdyk']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='osnIbRHcMW']");
			decrypt("upTZVvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='SFnGTWhcCf']");
			decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxLTnsZmPJiXEohO", "span[style*='SnFeXoYRGF']");
			decrypt("vBIiyHArRYXlVhqdtZQxOzKjgPcwSEDaMsCUnbNpfoWeGukJTLFm", "span[style*='sPUojBfbeq']");

            decrypt("NXFoTgnBCDVqEKeyxGrRlwjkhaIWdHpZsJfYMQSUAtLziOmvcubP", "span[style*='evCAvznupi']");
            decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='gmRTLUvdhk']");
            decrypt("ZhBxqGpCuKXjcVQebPlmHgzsdvritDUSWaYwJnIyLEMRONoAkfFT", "span[style*='HkUekbDUso']");
            decrypt("ViphqmcezIsEnaBKkUGoyQJxrufTYOLRFjwlXStDAHdWMPvbCNZg", "span[style*='IaTnbCzrXa']");
            decrypt("geLIkWUOrHlZdTcESQRPhpwsnGboMVuyJNjtzYXBqKDCAfmxFvia", "span[style*='JfVrIXKmBq']");
            decrypt("HfdFkPlmYisAcWLtKICaXeguDRnphZTJwEQqOGVzjoSvMByNxbrU", "span[style*='kaUxeTmnga']");
            decrypt("AqlHphQCbUZgnYieWuwLzTvJMFxIPKtRmoarEskDVjGNcfXyBdOS", "span[style*='LGhNIdwnGr']");
            decrypt("QphrHZeTVRUWlKmCsdXEGuwbaovSFIJDfnqOcYBixkzjLMAgyNtP", "span[style*='lIPSVkiFxq']");
            decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCXjR", "span[style*='MScrzUytnd']");
            decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='nMsHqQHjTB']");
            decrypt("qJPDVylcKsSLCNtnfbmRwdaxHEprjIoiBYhGvOeuTWgzFQUZAkxM", "span[style*='OlnMumSDSP']");
            decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='rUXAGMfAUa']");
            decrypt("ZBnzlOeqoWJatxTLMNpDCYIFdfQvwbUEjGumHikrVXPKRcShsygA", "span[style*='rxLCzrHHYw']");
            decrypt("mLPWMFVSInDUzBxivJhoOwlCZEpgAGqsyQfrjXabedKHNkTRYtuc", "span[style*='rYsQGMcEPs']");
            decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='THNZZCNYPg']");
            decrypt("fKTZFizMDpxBcRWINtoqSPChldAvGeHnOJugkXwLmUYyrasVQEbj", "span[style*='WYCajEmRla']");
            decrypt("HqOPjeAgIRWtQFyaKBCVGNZrUXdopflwMYEivJsSTucDxnhbzmLk", "span[style*='YQolTfNhqV']");

			decrypt("BZbgSrOAdKkspTNVaJEWIQtmxFzflnGcHLqDviUheYuMyPowCXjR", "span[style*='aGLhdYTJty']");
			decrypt("RWOVtgzYjNfXMPQqscdZKwrLlFBCevhHSAEDIpnoGTukibyxamJU", "span[style*='ETqeQsLyeX']");
			decrypt("aDtPrWLUgMHlGbkvsQCeoTNAxYjzXcuKEyqIfJRdBOFmZwiSpnVh", "span[style*='InXSZxRZDA']");
			decrypt("cqaYjtiIAXehDVgUGCBfPsTJNELzZwyHnWRSlMudokFpQvmKrObx", "span[style*='JylgYJsELr']");
			decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='KwFijplLDW']");
			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='KzXQJMAbeQ']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='lGwwdAzVpb']");
			decrypt("TqAocipRUanGQmJlSxWZMgHhCrIPkfVFKbEwjXLdBeNsYuOzDtyv", "span[style*='LlfMjxzrxA']");
			decrypt("TsaIRfGZnyhKvYobSeUgOBmlXCAVcwHzpLDxduPtJFQNiWrMjkqE", "span[style*='lYUVOsRomt']");
			decrypt("SwVuEnpXNaxfrihyQFIPOLmMYZUjlvRJeHodbDGATsBkztgcqWCK", "span[style*='mqJwSJHgNi']");
			decrypt("xPUhYNEyqXpjClKvZLJwFHWukfRnIdcVODAgrzQMtaBimbGoeTsS", "span[style*='SVoaXIarVv']");
			decrypt("YuZqUFnHITMGlebCtQrKLSgfxJvDwsBiaWRkNdEXmOjVzohAycpP", "span[style*='tsusKRhaHs']");
			decrypt("cHMZtWYfaEipjXbRPLogAFSBDVrOmUNxIlkeCszTuwKhdJnGqQyv", "span[style*='vOdhhsnKrb']");
			decrypt("whxqtFgAkKVdZEpWzBsvSUNjLfIPuHabrCDRGXeQolyTOciJMYnm", "span[style*='WuqsJwLTql']");
			decrypt("jkTGEJOByaPzKgnCeIDimbNqMvlwpxQZdXFroVWcuhsRfUASHLtY", "span[style*='XgfZvRqUVQ']");

			decrypt("CRLUaqKEwPhAdFIYZDQNpxBnSisvjucGTzOgfekXJbmrWtoVyHlM", "span[style*='AuzqdkQxPx']");
			decrypt("xoymMIDzBNkQVEnXGOaiThpeAjWUcZvPlJLCfwtKSbsYrdRqugFH", "span[style*='CtyCAedIbL']");
			decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='wZjCwArOrl']");
			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='XbeWXcpIsA']");
			decrypt("sFUShVjieBHoQArygKWqTdPELkNIftXwcDZmpxuzbYJMnvORlCaG", "span[style*='yUeCzFcJJm']");
			decrypt("VStMAakjpfRQFUGWeqrguCdblcvYIDHNKzywBxKTnsZmPJiXEohO", "span[style*='ZArUwifbSb']");
			decrypt("ZCmagAnbByNiEIvutJqOpLxrSQfhzwjDUCRlMFKGXTWPHoYcksed", "span[style*='ZrYVtfVZmo']");
			decrypt("EDBHyibcKYCjtFmzgVArLIRXndfPhuwvTOseZlUaoxNpGJqMWkSQ", "span[style*='aCZVqRoFcs']");
			decrypt("AiHqunvkxlfdBZNgPwFCtMIYXOEVyLczSRsaKmGhJUeTbDpjoQrW", "span[style*='AuYSCJTYbE']");
			decrypt("FGqNYQLTPUHecErxRucjBkDXbMaKyfzOhJdipolAgWItZVsnmSvw", "span[style*='ivCbHOdzWJ']");
			decrypt("VROtYexfAGoarQSWZcuCypvNMljiIUbqHKmkhXgPdnTFwJEDBLzs", "span[style*='tlmkkbAFgm']");
			decrypt("upTZvvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='TXtyhaGIbz']");
			decrypt("cqaYjtiIAXehDVgUGCBfPsTJNELzZwyHnWRSlMudokFpQvmKrObx", "span[style*='VDvuGujiMw']");
			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='zFmNwIUwLr']");
			decrypt("PwzuNiaQBycMxhZfElTdLkegHRUJrjWKXVYmADoqntOCGsSIpFbv", "span[style*='ZzNoUkLtWm']");
			
			decrypt("icHNSUwesAGBaCnZYgQVkdjbEWIPXfpDyJtForhvMzuKTqRIxOLm", "span[style*='aVAXfhbUMh']");
			decrypt("jbsUhGHLVKtioYfAnrvTIBdpFOWgMExDRPyXNzeQawZulkSqmcCJ", "span[style*='AVLEAeLduB']");
			decrypt("upTZvvjGaMwRBUXelqJACQfFkybrEnmoWcgHxYPztSshDOIdLiKN", "span[style*='BdWdybGmXa']");
			decrypt("DwChjXeaLTrHMBxEzfsuPKmWcJqZbiASNlVRFpGgkQdUoyOvntYI", "span[style*='CPiSTRXvDt']");
			decrypt("FINtlAjGYqeXHKDuPdBhpsWvQnLSJmrbxkyzwZogcfRVOUTECaMi", "span[style*='dBSflWZmZV']");
			decrypt("geLIkWUOrHlZdTcESQRPhpwsnGboMVuyJNjtzYXBqKDCAfmxFvia", "span[style*='dcNWrcHCOb']");
			decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='jGJUlzMxeD']");
			decrypt("ltTWhQwUrJcBPAuvRjSskzKOVYgHZeyIdFfqMpoxXnEmLCGiNabD", "span[style*='MazjIwDjyC']");
			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='NlTxLuCfZG']");
			decrypt("MFbcZDXiNudarsGYTogEAUjBxyIvzkSHVRwKfQOWmhLqtneplPCJ", "span[style*='RBXkdgjvaH']");
			decrypt("JznCuUZtTgKGAkvwBSOYLHsihaNEPpMVefWRoqlymbjcIXrdQDFx", "span[style*='TJVcAbanWb']");
			decrypt("KFhayuLfBRAgqJvnjeSHwPMUQzEcrTpbkOZxVlYNiXstGoWImCDd", "span[style*='TJzLNpqlfl']");
			decrypt("EmIhxnBkJVTwsuPQqvAcOaSyeXKDoztpYCNRFgMGrLlHiWfbUjdZ", "span[style*='TYomNebXLN']");
			decrypt("SBGwfKvctrjOmdyzXAYJWxhqReUDIaLiEFTNulPZoHgbksMpVQCn", "span[style*='utkyBOpKZY']");
			decrypt("uZCQtkAyRnJgxGVTbEXYwOBlWhvmKqoPrjdceHNDpUzfSFMaisIL", "span[style*='ytVzUUMXhQ']");
			decrypt("eOqaECAymwKpRhdcvWNLTxUHgnVXfSoMjPJkZQbDtBFGizYrIlsu", "span[style*='ZCaXtbbZml']");

            decrypt("tonquerzlawicvfjpsyhgdmkbxJKABRUDQZCTHFVLIWNEYPSXGOM", "span.jum");

            [...dom.querySelectorAll("span, p, h2")]
                .filter(e => e.style.height === "1px")
                .forEach(e => e.remove())

            if (!Window.epubstate) {
                Window.epubstate = new Set();
            }

            let known = Window.epubstate;
            for (let span of dom.querySelectorAll("span[style^='font-family']")) {
                let name = span.getAttribute("style").split(":")[1].trim().replace(";", "");
                if (!known.has(name)) {
                    known.add(name);
                    console.error("Unknown cypher: " + name);
                }
            }
            return true;
        }
        return this.processEachXhtmlFileAsync(mutator);
    }

    runScript(script) {
        let mutator = new Function("dom", "zipObjectName", script);
        return this.processEachXhtmlFile(mutator);
    }

    runScriptAsync(script) {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        let asyncMutator = new AsyncFunction("dom", "zipObjectName", script);
        return this.processEachXhtmlFileAsync(asyncMutator);
    }

    runRawScript(script) {
        const that = this;
        const rawMutator = new Function("initialHtml", "zipObjectName",
            "let html = initialHtml;\n" +
            "let result = (function() {\n" + script + "\n})();\n" +
            "return {html: html, result: result};");
        let sequence = Promise.resolve();
        for (let zipObjectName of this.opf.xhtmlNames()) {
            sequence = sequence.then(() => {
                const file = that.zip.file(zipObjectName);
                if (!file) return;
                return file.async("text").then(html => {
                    const output = rawMutator(html, zipObjectName);
                    let newHtml = output && typeof output.html === "string" ? output.html : html;
                    let modified = output && output.result === true;
                    if (typeof output?.result === "string") {
                        newHtml = output.result;
                        modified = newHtml !== html;
                    }
                    if (modified || newHtml !== html) {
                        const options = that.createZipOptions(file);
                        that.zip.file(zipObjectName, newHtml, options);
                        that.zipObjects.set(zipObjectName, that.zip.file(zipObjectName));
                    }
                });
            });
        }
        return sequence;
    }

    runRawScriptAsync(script) {
        const that = this;
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const rawMutator = new AsyncFunction("initialHtml", "zipObjectName",
            "let html = initialHtml;\n" +
            "let result = await (async function() {\n" + script + "\n})();\n" +
            "return {html: html, result: result};");
        let sequence = Promise.resolve();
        for (let zipObjectName of this.opf.xhtmlNames()) {
            sequence = sequence.then(() => {
                const file = that.zip.file(zipObjectName);
                if (!file) return;
                return file.async("text").then(html => rawMutator(html, zipObjectName).then(output => {
                    let newHtml = output && typeof output.html === "string" ? output.html : html;
                    let modified = output && output.result === true;
                    if (typeof output?.result === "string") {
                        newHtml = output.result;
                        modified = newHtml !== html;
                    }
                    if (modified || newHtml !== html) {
                        const options = that.createZipOptions(file);
                        that.zip.file(zipObjectName, newHtml, options);
                        that.zipObjects.set(zipObjectName, that.zip.file(zipObjectName));
                    }
                }));
            });
        }
        return sequence;
    }

    sanitizeXhtml() {
        let mutator = function(dom, zipObjectName) {
            let newBody = new Sanitize().clean(dom.body);
            dom.body = newBody;
            return true;
        }
        return this.processEachXhtmlFile(mutator);
    }

    processEachXhtmlFile(mutator) {
        let sequence = Promise.resolve();
        let that = this;
        Window.epubstate = null;
        for(let zipObjectName of this.opf.xhtmlNames()) {
            sequence = sequence.then(function () {
                return that.extractXhtnml(zipObjectName);
            }).then(function(dom) {
                let modified = mutator(dom, zipObjectName);
                return that.replaceZipObject(zipObjectName, dom, modified);
            });                
        }
        return sequence;
    }

    processEachXhtmlFileAsync(asyncMutator) {
        let sequence = Promise.resolve();
        const that = this;
        Window.epubstate = null;
        for (const zipObjectName of this.opf.xhtmlNames()) {
            sequence = sequence
                .then(() => {
                    return that.extractXhtnml(zipObjectName);
                })
                .then(async (dom) => {
                    const modified = await asyncMutator(dom, zipObjectName);
                    return that.replaceZipObject(zipObjectName, dom, modified);
                });
        }
        return sequence;
    }

    convertTableToDiv() {
        let mutator = function(dom, zipObjectName) {
            function replaceTableToDivHelper(element, elementtoreplace, csstext) {
                if (element == null || element == undefined) {
                    return;
                }
                for(let node of [...element.querySelectorAll(elementtoreplace)]) {
                    let elementchildren = [...node.childNodes];
                    let div = document.createElement("div");
                    div.append(...elementchildren);
                    if (elementtoreplace == "table") {
                        node.parentNode.style.overflow = "visible";
                    }
                    if (csstext != "") {
                        div.style.cssText = csstext;
                    }
                    node.replaceWith(div);
                }
            }
            for(let table of [...dom.querySelectorAll("table")]) {
                replaceTableToDivHelper(table, "td", "flex: 1;padding: 5px;border: 1px solid black;");
                replaceTableToDivHelper(table, "tr", "display: flex;border: 1px solid black;");
                replaceTableToDivHelper(table, "tbody", "");
                replaceTableToDivHelper(table.parentNode, "table", "border-collapse: collapse;width: 100%;");
            }
            return true;
        }
        return this.processEachXhtmlFile(mutator);
    }

    appendSourceLinkInEachChapter() {
        let sequence = Promise.resolve();
        let that = this;
        let contentopfpath = "OEBPS/content.opf";
        sequence = this.extractXhtnml(contentopfpath).then(function(contentopf) {
            let sequence = Promise.resolve();
            let regex = new RegExp(/^xhtml[0-9]+/g);
            let chapters = [...contentopf.querySelectorAll("item")].filter(a => (a.id.match(regex) != null));
            let chaptersource = chapters.map(a => ["OEBPS/"+a.attributes.href.textContent, contentopf.getElementById("id." + a.id).innerText]);
            let chaptersourceobject = Object.fromEntries(chaptersource);
            for(let zipObjectName of that.opf.xhtmlNames()) {
                sequence = sequence.then(function () {
                    return that.extractXhtnml(zipObjectName);
                }).then(function(dom) {
                    let link = chaptersourceobject[zipObjectName];
                    if (link != null) {
                        let div = dom.createElement("div");
                        let p = dom.createElement("p");
                        let a = dom.createElement("a");
                        p.innerText = "Source: ";
                        a.href = link;
                        a.innerText = link;
                        div.appendChild(p);
                        p.appendChild(a);
                        dom.body.appendChild(div);
                        return that.replaceZipObject(zipObjectName, dom, true);
                    }
                    return that.replaceZipObject(zipObjectName, dom, false);
                });                
            }
            return sequence;
        });  
        return sequence;
    }

    linkExtraFonts() {
        let sequence = Promise.resolve();
        let allkeys = [...this.zipObjects.keys()];
        allkeys = allkeys.filter(a => a.startsWith("OEBPS/Fonts/")).map(a => a.replace("OEBPS/Fonts/", ""));

        let that = this;
        let stylesheetpath = "OEBPS/Styles/stylesheet.css";

        let file = this.zipObjects.get(stylesheetpath);
        sequence = file.async("text").then(function (text){
            for (let i = 0; i < allkeys.length; i++) {
                text = text + "\n@font-face {\n  src: url(../Fonts/"+allkeys[i]+");\n  font-family: \""+allkeys[i].replace(/\..+/,"")+"\";\n}\n";
            }
            let options = that.createZipOptions(file);
            return that.zip.file(stylesheetpath, text, options);
        });
        return sequence;
    }

    async linkExtraFonts() {
        let stylesheetpath = "OEBPS/Styles/stylesheet.css";
        let contentopfpath = "OEBPS/content.opf";
        let file = this.zipObjects.get(stylesheetpath);
        let stylesheettext = await file.async("text");
        file = this.zipObjects.get(contentopfpath);
        let contentopftext = await file.async("text");
        let allkeys = [...this.zipObjects.keys()];
        let fontPaths = allkeys.filter(a => a.startsWith("OEBPS/Fonts/"));
        let newFontPaths = new Map();
        for (let fontPath of fontPaths) {
            if (fontPath.endsWith(".woff2")) {
                let file = this.zipObjects.get(fontPath);
                let woff2Data = await file.async("uint8array");
                let decompressed = await Module.decompress(woff2Data);

                let ext = this.getFontExtension(decompressed);
                let newFontPath = fontPath.replace(".woff2", ext);
                //otherwise it saves the same data under different filepaths
                let isolatedData = new Uint8Array(decompressed);
                this.zip.file(newFontPath, isolatedData, {binary: true});
                this.zip.remove(fontPath);

                stylesheettext = stylesheettext + "\n@font-face {\n  src: url(../Fonts/" + newFontPath.replace("OEBPS/Fonts/", "") + ");\n  font-family: \"" + newFontPath.replace("OEBPS/Fonts/", "").replace(/\..+/, "") + "\";\n}\n";

                let item = '<item href="/Fonts/' + newFontPath.replace("OEBPS/Fonts/", "")+'" id="'+ newFontPath.replace("OEBPS/Fonts/", "").replace(/\..+/, "")+'" media-type="font/'+(ext.replace(".", ""))+'"/>\n';
                contentopftext = contentopftext.replace("</manifest>", item+"</manifest>");
            } else {
                stylesheettext = stylesheettext + "\n@font-face {\n  src: url(../Fonts/" + fontPath.replace("OEBPS/Fonts/", "") + ");\n  font-family: \"" + fontPath.replace("OEBPS/Fonts/", "").replace(/\..+/, "") + "\";\n}\n";

                let item = '<item href="/Fonts/' + fontPath.replace("OEBPS/Fonts/", "")+'" id="'+ fontPath.replace("OEBPS/Fonts/", "").replace(/\..+/, "")+'" media-type="font/'+(fontPath.split(".").pop())+'"/>\n';
                contentopftext = contentopftext.replace("</manifest>", item+"</manifest>");
            }
        }
        let options = this.createZipOptions(file);
        //for apple user
        contentopftext = contentopftext.replace("</manifest>", '<meta property="ibooks:specified-fonts">true</meta>'+"</manifest>");
        this.zip.file(contentopfpath, contentopftext, options);
        return this.zip.file(stylesheetpath, stylesheettext, options);
    }
    
    getFontExtension(data) {
        if (data && data.length >= 4) {
            // "OTTO" is 0x4F, 0x54, 0x54, 0x4F
            if (data[0] === 0x4F && data[1] === 0x54 && data[2] === 0x54 && data[3] === 0x4F) {
                return ".otf";
            }
        }
        return ".ttf";
    }


    updateDate(dateString) {
        let dateEl = this.opf.dom.querySelector("dc\\:date:not([opf\\:event])");
        if (dateEl !== null) {
            dateEl.textContent = dateString;
        }
        return Promise.resolve(this.replaceZipObject(this.opf.zipObjectName, this.opf.dom, true));
    }

    checkForInvalidXhtml() {
        let sequence = Promise.resolve();
        let bad = [];
        let that = this;
        for(let zipObjectName of this.opf.xhtmlNames()) {
            sequence = sequence.then(function () {
                let file = that.zipObjects.get(zipObjectName);
                return file.async("text")
            }).then(function(text) {
                let error = that.findXhtmlError(text);
                if (error != null) {
                    bad.push({zipObjectName, error: error.textContent});
                }
            });                
        }
        return sequence.then(() => bad);
    }

    extractImages(filename, startChapterIndex) {
        let newZip = new JSZip();
        let sequence = Promise.resolve();
        let that = this;
        let chapterIndex = startChapterIndex;
        for(let zipObjectName of this.opf.xhtmlNames()) {
            let chapterName = ("00" + chapterIndex);
            chapterName = "c" + chapterName.substring(chapterName.length - 3);
            ++chapterIndex;
            sequence = sequence.then(function () {
                return that.extractXhtnml(zipObjectName);
            }).then(function(dom) {
                return that.copyImages(newZip, dom, chapterName);
            });                
        }
        return sequence
            .then(newZip => newZip.generateAsync({ type: "blob" }))
            .then(blob => this.writeToDisk(filename, blob));
    }

    copyImages(newZip, dom, chapterName) {
        let that = this;
        let sequence = Promise.resolve();
        let index = 0;
        for(let element of dom.querySelectorAll("image")) {
            sequence = sequence.then(function () {
                let src = element.getAttribute("xlink:href");
                let desc = src.split("/");
                let leaf = that.makeLeafName(++index, desc[desc.length - 1]);
                if (999 < index) {
                    throw new Error("Too many images in chaper");
                }
                let oldZipObjectname = "OEBPS" + src.substring(2);  // ToDo  Do this properly.
                let newZipObjectName = chapterName + "/" + leaf;
                console.log(`"${newZipObjectName}, "${desc}"`);
                return that.copyImage(newZip, oldZipObjectname, newZipObjectName);
            });
        };
        return sequence;
    }

    makeLeafName(index, originalName) {
        let ext = originalName.substring(originalName.lastIndexOf("."));
        let name = ("00" + index);
        name = name.substring(name.length - 3);
        return name + ext;
    }

    copyImage(newZip, oldZipObjectname, newZipObjectName) {
        let that = this;
        let file = this.zipObjects.get(oldZipObjectname);
        return file.async("blob").then(function (blob){
            let options = that.createZipOptions(file);
            return newZip.file(newZipObjectName, blob, options);
        });
    }

    findXhtmlError(xhtmlAsString) {
        let doc = new DOMParser().parseFromString(xhtmlAsString, "application/xml");
        return doc.querySelector("parsererror");
        return (parsererror === null) ? null : parsererror.textContent;
    }

    replaceZipObject(zipObjectName, newDom, modified) {
        if (modified) {
            let text = new XMLSerializer().serializeToString(newDom);
            text = this.patchHtmlConversion(text);
            let file = this.zipObjects.get(zipObjectName);
            let options = this.createZipOptions(file);
            return this.zip.file(zipObjectName, text, options);
        }
    }

    patchHtmlConversion(textToFix) {
        return textToFix.replace("<!--?xml version=\"1.0\" encoding=\"utf-8\"?-->", 
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>");
    }

    removeItems(items) {
        for(let i of items) {
            this.zip.remove(this.opf.zipNameForItem(i));
        };
        let modified = this.opf.removeItems(items);
        return this.replaceZipObject(this.opf.zipObjectName, this.opf.dom, modified);
    }

    listImagesInViewOrder() {
        let sequence = Promise.resolve();
        let that = this;
        let images = [];
        for(let zipObjectName of this.opf.xhtmlNames()) {
            sequence = sequence.then(function () {
                return that.extractXhtnml(zipObjectName);
            }).then(function(dom) {
                for(let element of dom.querySelectorAll("img, image")) {
                    let attribName = (element.tagName.toUpperCase() === "IMG") ? "src" : "xlink:href";
                    let src = element.getAttribute(attribName).split("/");
                    images.push(src[src.length - 1]);
                }
            });                
        }
        return sequence.then(
            () => images
        );
    }

    isZeroLength(zipObjectName) {
        let size = this.zipObjects.get(zipObjectName)._data.uncompressedSize;
        return size === undefined || size === 0;
    }
}
