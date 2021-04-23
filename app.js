const https = require('https');
const aws = require('aws-sdk');

const s3 = new aws.S3({
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY
});

var dstBucket = process.env.DST_BUCKET;
var API_KEY = process.env.API_KEY;

var id;
var type;
var filename;

var apilist = [];
var resp = new Object();

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
        "Access-Control-Allow-Headers" : "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    };

    try {

        body = await new Promise((resolve, reject) => {
      
            switch (event.httpMethod) {
                case 'POST':
                    
                    apilist = new Array();
                    resp = new Object();

                    for (var x = 0; x < params.length; x++) {                    
                        id = params[x].id;
                        type = params[x].type;                            
                        filename = type + "_" + id;
                        
                        switch (type) {    
                            case 'place':
                            case 'youtube':
                            case 'book':                                
                                promises.push(getFile(filename, type, id));
                            break;
                        }
                    }

                break;

                default:
                    throw new Error(`Unsupported method "${event.httpMethod}"`);
            }

            Promise.all(promises).then(function() {
                console.log("final callAPI: ", apilist);

                for (var x = 0; x < apilist.length; x++) {
                    promisesAPI.push(callAPI("https://www.googleapis.com/books/v1/volumes/", apilist[x].type, apilist[x].id));
                }
     
                Promise.all(promisesAPI).then(function() {
                    console.log("resp: ", resp);
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
    };
}

async function callAPI(url, type, id) {    
    let dataString = '';

    console.log("URL: ", url);
    console.log("FULLURL: ", url + "&key=" + API_KEY);

    var link = url + id;
    if (type == 'place' || type == "youtube") {
        link += "&key=" + API_KEY;
    }

    console.log("LINK IS: ", link);
    
    const response = await new Promise((resolve, reject) => {
        const req = https.get(link , function(res) {
          res.on('data', chunk => {
            dataString += chunk;
          });
          res.on('end', () => {
            let name = type + "_" + id;
            resp[name] = JSON.parse(dataString);
            copyToS3(dataString, name).then(function() {
                resolve({
                    statusCode: 200,
                    //body: JSON.stringify(JSON.parse(dataString), null, 4)
                    body: JSON.parse(dataString)
                });
            }, reject);
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
    console.log("inside copyToS3 cotent: ", content);
    console.log("inside copyToS3 filename: ", filename);

    const params = {
        Bucket: dstBucket,
        Key: filename + ".json", 
        Body: JSON.stringify(content, null, 2)
    };

    console.log("inside copyToS3 params: ", params);

    const response = await new Promise((resolve, reject) => {
        s3.upload(params, function(s3Err, data) {
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

    const params = {
        Bucket: dstBucket,
        Key: filename + ".json", 
    };

    const response = await new Promise((resolve, reject) => {
        s3.headObject(params, function (err, metadata) {  
            if (err && err.code === 'NotFound') { 
                console.log("object not found"); 
                //return false;
                apilist.push({type: type, id: id});
                resolve({statusCode: 404, data: "Object not found.", type: type, id: id});
            } else {

                s3.getObject(params, function(err, result) {
                    if (err) console.log(err, err.stack); // an error occurred
                    else {
                        let objectData = result.Body.toString('utf-8'); // Use the encoding necessary
                        console.log("getobject objectData:", objectData);
                        console.log("getobject JSON.parse(objectData):", JSON.parse(objectData));
                        //console.log("getobject jsonEscape(objectData):", jsonEscape(objectData));
                        resp[filename] = JSON.parse(jsonEscape(objectData));
                        resolve({statusCode: 200, data: objectData, type: type, id: id});              
                    }
                });              
            }
        });          
    });

    return response;
}

function jsonEscape2(str)  {
    return str.replace(/\n/g, "\\\\n").replace(/\r/g, "\\\\r").replace(/\t/g, "\\\\t");
}

function jsonEscape(str)  {
    return str.replace(/\\n/g, '');
}