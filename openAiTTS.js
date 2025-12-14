import { promises as fs,writeFileSync,unlinkSync } from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import crypto from 'crypto';

// Constants for file uploads
const baseUrl = 'https://www.call2all.co.il';
const chunkSize = 20000000;


async function* getChunks(filePath, chunkSize) {
    const file = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(chunkSize);

    try {
        while (true) {
            const result = await file.read(buffer, 0, chunkSize);
            if (result.bytesRead === chunkSize)
                yield result.buffer;
            else {
                yield result.buffer.slice(0, result.bytesRead);
                break;
            }
        }
    } finally {
        await file.close();
    }
}

function createFormData(tokenYemot, bytes, contentName, partialData = null, path,  name = null) {
    const data = {
        token: tokenYemot,
        path,
        convertAudio: 1,
        autoNumbering: 1
    };

    if (partialData) {
        data.uploader = 'yemot-admin';
        data.qquuid = partialData.uuid;
        data.qqfilename = contentName;
        data.qqtotalfilesize = partialData.fileSize;
        data.qqtotalparts = partialData.partCount;

        //in final post request we don't need to send the file
        if (partialData.part < partialData.partCount) {
            data.qqpartbyteoffset = chunkSize * partialData.part;
            data.qqpartindex = partialData.part;
            data.qqchunksize = bytes.length;
        }
    }

    const formData = new FormData();
    for (const [key, value] of Object.entries(data))
        formData.append(key, value);

    if (bytes)
        formData.append(partialData ? 'qqfile' : 'file', Buffer.from(bytes), { filename: contentName, contentType: 'application/octet-stream' });

    return formData;
}

async function uploadFile(tokenYemot, filePath,  path, name = null) {
    const fileSize = (await fs.stat(filePath)).size;
    const callApi = (url, payload) => fetch(url, { method: 'POST', body: payload });
    const chunks = getChunks(filePath, chunkSize);
    const contentName = filePath.split('/').pop();

    if (fileSize <= chunkSize) {
        const formData = createFormData(tokenYemot, (await chunks.next()).value, contentName, null, path, name);
        await chunks.return();
        return await callApi(baseUrl + '/ym/api/UploadFile', formData).then(x => x.json());
    } else {
        const uuid = crypto.randomUUID();
        const partCount = Math.ceil(fileSize / chunkSize);

        let part = 0;
        for await (const chunk of chunks) {
            const formData = createFormData(tokenYemot, chunk, contentName, { uuid, fileSize, partCount, part: part++ }, path, name);

            const status = await callApi(baseUrl + '/ym/api/UploadFile', formData).then(x => x.json());
            if (!status.success) {
                console.log(status);
                throw new Error(status.message);
            }
        }

        return await callApi(baseUrl + '/ym/api/UploadFile?done', createFormData(tokenYemot, null, contentName,
            { uuid, fileSize, partCount, part }, path, name)).then(x => x.text());
    }
}

async function ttsUpload(openai, text, uploadPath = "ivr/1", tokenYemot) {
    try {
        const ttsResult = await ttsOpenAI(openai, text);
        if (!ttsResult) return false;
        // Create a temporary file name with the voice name and a timestamp
        const tempFileName = `./temp/temp_${Date.now()}.mp3`;

        // Write the binary data to a temporary file
        writeFileSync(tempFileName, Buffer.from(ttsResult));
        // Upload the file using the existing uploadFile function
        let uploadResult = await uploadFile(tokenYemot, tempFileName, `ivr/${uploadPath}`);

        // Clean up the temporary file
        unlinkSync(tempFileName);

        // Process the upload result
        let fileInfo;
        try {
            let splitResponse = uploadResult.split('}{');
            if (splitResponse.length > 1) {
                let firstJson = splitResponse[0] + '}';
                fileInfo = JSON.parse(firstJson);
            } else {
                fileInfo = typeof uploadResult === 'string' ? JSON.parse(uploadResult) : uploadResult;
            }
        } catch (error) {   
            fileInfo = uploadResult;
        }

        // If fileInfo is an object with path property, return the path,
        // otherwise return the full fileInfo for debugging
        let path = fileInfo && fileInfo.path ? fileInfo.path : fileInfo;
        return path.split('ivr')[1].split(".")[0];
    } catch (error) {
        console.error('TTS upload error:', error);
        return false;
    }
}

async function ttsOpenAI(openai, text) {
    const mp3 = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "onyx",
        input: text,
    });
    return await mp3.arrayBuffer();
}
// Export the functions
export default ttsUpload; 