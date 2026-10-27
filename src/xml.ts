import { XMLParser } from 'fast-xml-parser';
import XMLBuilder from 'fast-xml-builder';

const xmlParser = new XMLParser({
    ignoreDeclaration: true,
    parseTagValue: false,
});

const xmlBuilder = new XMLBuilder();

/** Parses an XML string and returns the name and value of its root element; both are `undefined` if there is none. */
export function parseXml<Result>(xml: string): { rootName: string | undefined; value: Result | undefined } {
    const entry = Object.entries(xmlParser.parse(xml))[0];
    return entry
        ? { rootName: entry[0], value: entry[1] as Result }
        : { rootName: undefined, value: undefined };
}

/** Serializes a JS object to an XML string; text values are escaped. */
export function buildXml(value: object): string {
    return xmlBuilder.build(value);
}
