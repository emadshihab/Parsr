/**
 * Copyright 2019 AXA Group Operations S.A.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { XmlEntities } from 'html-entities';
import * as os from 'os';
import { BoundingBox, Document, Font, Page, Text, Word } from '../../types/DocumentRepresentation';
import { Pdf2JsonFont } from '../../types/Pdf2JsonFont';
import { Pdf2JsonPage } from '../../types/Pdf2JsonPage';
import * as utils from '../../utils';
import logger from '../../utils/Logger';

/**
 * Executes the pdf2json extraction function, reading an input pdf file and extracting a document representation.
 * This function involves recovering page contents like words, bounding boxes, fonts and other information that
 * the pdf2json tool's output provides. This function spawns the externally existing pdf2json tool.
 *
 * @param pdfInputFile The path including the name of the pdf file for input.
 * @returns The promise of a valid document (in the format DocumentRepresentation).
 */
export function execute(pdfInputFile: string): Promise<Document> {
	const xmlEntities = new XmlEntities();
	return new Promise<Document>((resolve, reject) => {
		return repairPdf(pdfInputFile).then(repairedPdf => {
			const jsonOutputFile: string = utils.getTemporaryFile('.json');
			logger.debug(`pdf2json ${['-enc', 'UTF-8', repairedPdf, jsonOutputFile].join(' ')}`);

			if (!fs.existsSync(jsonOutputFile)) {
				fs.appendFileSync(jsonOutputFile, '');
			}

			const pdf2json = spawn('pdf2json', ['-enc', 'UTF-8', repairedPdf, jsonOutputFile]);

			pdf2json.stderr.on('data', data => {
				logger.error('pdf2json error:', data.toString('utf8'));
			});

			pdf2json.on('close', code => {
				if (code === 0) {
					logger.info('Reading json file...');
					const json: JSON = JSON.parse(fs.readFileSync(jsonOutputFile, 'utf8'));
					const jsonPages = (json as any) as Pdf2JsonPage[];
					const pdfPages: Pdf2JsonPage[] = jsonPages.map(p => new Pdf2JsonPage(p));

					const RATIO = 2 / 3;
					const pdfFonts: Pdf2JsonFont[] = pdfPages
						.map(pdfPage => pdfPage.fonts)
						.reduce((a, b) => a.concat(b));
					const fonts: Font[] = [];
					const pages: Page[] = pdfPages.map((pdfPage: Pdf2JsonPage) => {
						const texts: Text[] = pdfPage.text
							.map(pdfText => pdfTextToWord(pdfText, pdfFonts, fonts, RATIO, xmlEntities))
							.filter(word => {
								// This can append sometimes with pdf2json
								return word.box.width > 0 && word.box.height > 0 && word.toString().trim() !== '';
							})
							.map(word => {
								word.box.width = Math.max(word.box.width, 0);
								word.box.height = Math.max(word.box.height, 0);
								if (word.content as string) {
									word.content = (word.content as string).trim();
								}
								return word;
							});

						return new Page(
							pdfPage.number,
							texts,
							new BoundingBox(0, 0, pdfPage.width * RATIO, pdfPage.height * RATIO),
						);
					});

					const doc: Document = new Document(pages, pdfInputFile);
					logger.debug('Done');
					resolve(doc);
				} else {
					reject(`pdf2json return code is ${code}`);
				}
			});
		});
	});
}

/**
 * Converts a string of text into a valid word entity (as in the Document Representation format).
 *
 * @param pdfText The string to be converted into a word.
 * @param pdfFonts List of fonts generated by the pdf2json tool.
 * @param fonts A collection of fonts existing in the current document.
 * @param RATIO The scaling ratio for the output word's bounding box.
 * @param xmlEntities An xmlEntities object for decoding the pdfText data to generate the word content.
 * @returns A valid Document Representation's word entity.
 */
function pdfTextToWord(pdfText, pdfFonts, fonts, RATIO, xmlEntities): Word {
	const pdfFont: Pdf2JsonFont = pdfFonts.filter(f => f.fontspec === String(pdfText.font))[0];

	const newFont = new Font(pdfFont.family, pdfFont.size, { color: pdfFont.color });
	const wordFont = findOrCreate(newFont, fonts);

	const word = new Word(
		new BoundingBox(
			pdfText.left * RATIO,
			pdfText.top * RATIO,
			pdfText.width * RATIO,
			pdfText.height * RATIO,
		),
		xmlEntities.decode(pdfText.data),
		wordFont,
	);

	return word;
}

/**
 * Finds or creates a new font object
 * @param newFont The name of the font to be searched or created
 * @param fonts The list of existing fonts
 * @returns A font object either containing an existing one that matches newFont, or a new object altogether.
 */
function findOrCreate(newFont: Font, fonts: Font[]): Font {
	for (const font of fonts) {
		if (font.isEqual(newFont)) {
			return font;
		}
	}

	fonts.push(newFont);
	return newFont;
}

/**
 * Repair a pdf using the external mutool utility.
 * @param filePath The absolute filename and path of the pdf file to be repaired.
 */
function repairPdf(filePath: string) {
	return new Promise<string>(resolve => {
		const mutoolSpawnPath = spawnSync(utils.getExecLocationCommandOnSystem(), ['mutool']);
		let mutoolPath = '';
		if (mutoolSpawnPath.output) {
			mutoolPath = mutoolSpawnPath.output.join('');
		}
		if (mutoolPath === '' || (/^win/i.test(os.platform()) && /no mutool in/.test(mutoolPath))) {
			logger.warn('MuPDF not installed !! Skip clean PDF.');
			resolve(filePath);
		} else {
			const pdfOutputFile = utils.getTemporaryFile('.pdf');
			const pdfFixer = spawn('mutool', ['clean', filePath, pdfOutputFile]);
			pdfFixer.on('close', () => {
				// Check that the file is correctly written on the file system
				fs.fsyncSync(fs.openSync(filePath, 'r+'));
				resolve(pdfOutputFile);
			});
		}
	});
}
