// Raw XHTML mode
// Remove only h2.chapter-title
// return true if chapter modified, false if not changed

let newHtml = html.replace(
    /<h2\b[^>]*class=["'][^"']*\bchapter-title\b[^"']*["'][^>]*>[\s\S]*?<\/h2>/gi,
    ""
);

if (newHtml !== html) {
    html = newHtml;
    return true;
}

return false;
