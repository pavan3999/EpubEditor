# Raw XHTML Script Mode

EpubEditor now has two custom-script modes:

- **DOM (existing)** — unchanged existing behavior. Scripts receive `dom` and `zipObjectName`.
- **Raw XHTML (preserve original markup)** — scripts receive `html` and `zipObjectName`.

Raw XHTML mode does not parse the chapter through DOMParser and does not serialize it with XMLSerializer. The modified string is written directly to the EPUB ZIP entry.

## Example

```javascript
let newHtml = html.replace(
    /<h2\b[^>]*class=["'][^"']*\bchapter-title\b[^"']*["'][^>]*>[\s\S]*?<\/h2>/gi,
    ""
);

if (newHtml !== html) {
    html = newHtml;
    return true;
}

return false;
```

This removes only matching `h2.chapter-title` elements and avoids reserializing unrelated XHTML.

Raw scripts may also return a string directly:

```javascript
return html.replace(/old/g, "new");
```

The existing DOM mode remains unchanged.
