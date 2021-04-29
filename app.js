const aws = require('aws-sdk');
const https = require('https');
const chromium = require('chrome-aws-lambda');
const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36';

const s3client = new aws.S3({
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_KEY
});

var dstBucket = process.env.DST_BUCKET;
var API_KEY = process.env.API_KEY;

var id;
var type;
var filename;

var apilist = [];
var resp = new Object();

var browser = null;

const BOOK_API = "https://www.googleapis.com/books/v1/volumes/";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3/videos?id=";
const PLACE_API = "https://maps.googleapis.com/maps/api/place/details/json?place_id=";
const PLACE_PHOTO__API = "https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=";

exports.handler = async (event, context) => {

    console.log('Received event:', JSON.stringify(event, null, 2));

    let params = JSON.parse(event["body"]);
    console.log("params: ", params);

    let body;

    const promises = [];
    const promisesAPI = [];
    let statusCode = '200';

    // enables CORS
    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    };

    try {

        body = await new Promise((resolve, reject) => {

            switch (event.httpMethod) {
                case 'POST':
                    apilist = new Array();
                    resp = new Object();
                    browser = null;

                    for (var i = 0; i < params.length; i++) {
                        id = params[i].id;
                        type = params[i].type;
                        filename = type + "_" + id;

                        if (type == 'url') {
                            filename = filename.replace(/(^\w+:|^)\/\//, '');
                            filename = filename.replace(/\/$/, "");
                        }

                        // check all requests if it exists in S3
                        promises.push(getFile(filename, type, id));
                    }
                    break;

                default:
                    throw new Error(`Unsupported method "${event.httpMethod}"`);
            }

            Promise.all(promises).then(function () {
                console.log("final callAPI: ", apilist);

                for (var i = 0; i < apilist.length; i++) {
                    switch (apilist[i].type) {
                        case 'place':
                            promisesAPI.push(callAPI(PLACE_API,
                                apilist[i].type, apilist[i].id));
                            break;

                        case 'youtube':
                            promisesAPI.push(callAPI(YOUTUBE_API,
                                apilist[i].type, apilist[i].id));
                            break;

                        case 'book':
                            promisesAPI.push(callAPI(BOOK_API,
                                apilist[i].type, apilist[i].id));
                            break;

                        case 'url':
                            promisesAPI.push(takeScreenshot(apilist[i].id));
                            break;

                        default:
                            throw new Error(`Unsupported type "${apilist[i].type}"`);
                    }
                }

                Promise.all(promisesAPI).then(async function () {
                    console.log("resp: ", resp);
                    if (browser !== null) {
                        await browser.close();
                        browser = null;
                    }
                    resolve(resp);
                });
            });
        });


    } catch (err) {
        statusCode = '400';
        body = err;
        console.log("body return error: ", err);

    } finally {
        body = JSON.stringify(body);
    }

    return {
        statusCode,
        body,
        headers,
    }; S
}

async function callAPI(url, type, id) {
    let dataString = '';
    let result;

    let link = url + id;
    let name = type + "_" + id;

    if (type == 'place') {
        link += "&key=" + API_KEY;

    } else if (type == 'youtube') {
        link += "&key=" + API_KEY + "&part=snippet";
    }

    console.log("API link: ", link);

    const response = await new Promise((resolve, reject) => {
        const req = https.get(link, function (res) {

            res.on('data', chunk => {
                dataString += chunk;
            });

            res.on('end', () => {
                result = JSON.parse(dataString);
                resolve();
            });
        });

        req.on('error', (e) => {
            reject({
                statusCode: 500,
                body: 'Something went wrong!'
            });
        });
    });

    if (type == 'youtube') {
        result['items'] = result.items[0];

    } else if (type == 'place') {
        result = result['result'];

        if (result.photos != null) {
            for (var x = 0; x < result.photos.length; x++) {
                let resp = await callPlacePhotosAPI(result.photos[x].photo_reference);
                result.photos[x]["url"] = resp.body;
            }
        }
    }

    console.log("final result: ", result);

    resp[name] = result;

    await copyToS3(result, name);

    return response;
}

async function callPlacePhotosAPI(photoReference) {
    let buffer;
    let link = PLACE_PHOTO__API + photoReference + "&key=" + API_KEY;

    console.log("Place Photos Link: ", link);

    let response = await new Promise((resolve, reject) => {
        const req = https.get(link, function (res) {

            res.on('data', chunk => {
                buffer += chunk;
            });

            res.on('end', () => {
                var url = buffer.substring(
                    buffer.lastIndexOf("HREF=") + 6,
                    buffer.lastIndexOf("here") - 2
                );

                console.log("url :", url);
                resolve({
                    statusCode: 200,
                    body: url
                });
            });
        });

        req.on('error', (e) => {
            reject({
                statusCode: 500,
                body: 'Something went wrong!'
            });
        });
    });

    return response;
}

async function copyToS3(content, filename) {

    const params = {
        Bucket: dstBucket,
        Key: filename + ".json",
        Body: JSON.stringify(content, null, 2)
    };

    const response = await new Promise((resolve, reject) => {
        s3client.upload(params, function (s3Err, data) {
            if (s3Err) {
                reject(s3Err);
            } else {
                console.log(`File uploaded successfully at ${data.Location}`);
                resolve();
            }
        });
    });

    return response;
}

async function getFile(filename, type, id) {

    let key = filename + ".json";
    if (type == 'url') {
        key = filename + ".png";
    }

    const params = {
        Bucket: dstBucket,
        Key: key,
    };

    console.log("Retrieving file in S3: ", key);

    const response = await new Promise((resolve, reject) => {
        s3client.getObject(params, async function (err, result) {
            if (err) {
                console.log(err, err.stack);

                if (type == 'url') {
                    await initiateBrowser();
                } 
                
                apilist.push({ type: type, id: id });
                resolve({ statusCode: 404, data: "Object not found.", err: err.stack });

            } else {
                let objectData = result.Body.toString('utf-8');

                if (type == 'url') {
                    resp["url_" + filename] = "https://" + dstBucket + ".s3.amazonaws.com/" + encodeURIComponent(key);
                } else {
                    resp[filename] = JSON.parse(objectData);
                }

                resolve({ statusCode: 200, data: objectData, type: type, id: id });
            }
        });
    });

    return response;
}

async function initiateBrowser() {
    if (browser == null) {
        try {
            console.log("Initiating browser");
            browser = await chromium.puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath,
                headless: chromium.headless,
                ignoreHTTPSErrors: true,
            });
        } catch(err) {
            console.log("Browser failed: ", err);
        } finally {
            console.log("Browser launched:", browser);
            return browser;
        }
    }
}

async function takeScreenshot(id) {
    let filename = id;
    let response;

    try {

        await initiateBrowser();
        
        let page = await browser.newPage();
        await page.setUserAgent(agent);
        console.log('Navigating to page: ', id);

        await page.goto(id);
        const buffer = await page.screenshot();
        await page.title();

        filename = filename.replace(/(^\w+:|^)\/\//, '');
        filename = filename.replace(/\/$/, "");

        const params = {
            Bucket: dstBucket,
            Key: filename + ".png",
            Body: buffer,
            ContentType: 'image/png',
            ACL: 'public-read'
        };

        response = await new Promise((resolve, reject) => {
            s3client.upload(params, function (s3Err, data) {
                if (s3Err) {
                    console.log("File uploaded s3Err at: ", s3Err);
                    reject(s3Err);
                } else {
                    resp["url_" + filename] = data.Location;
                    console.log(`File uploaded successfully at ${data.Location}`);
                    resolve();
                }
            });
        });

        await page.close();

    } catch (error) {
        console.log(error);

    } finally {
        // if (browser !== null) {
        //     await browser.close();
        //     browser = null;
        // }

        return response;
    }
}