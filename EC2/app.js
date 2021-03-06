
// STANDARD STUFF
var express = require('express');
var util   = require('util');
var fs = require('fs');
var path = require('path');
var fileUp = require('express-fileupload');

// Custom modules
var xS3       = require('./app_s3.js');
var xDynamo   = require('./app_dynamo.js');
var xValidate = require('./app_validate.js');

var AWSREGION  = process.env.AWSREGION  || "eu-west-1";
var BUCKETNAME = process.env.BUCKETNAME || "img-bucket-irw";

var TIMER = (process.argv.indexOf("--time") != -1) ? true : false;

var app = express();

var staticPath = path.join(__dirname, '/public');
app.use(express.static(staticPath));

app.use(fileUp());


app.get("/", function(req, res) {
    res.sendFile("/public/");
});

app.get('/getimagelist',   function(req, res) {
    xS3.listS3files().then(response => {
        res.status(200);
        res.json(response);
    })
    .catch(console.error);
});


app.post('/upload', function(req, res) {
    if (TIMER) {
        var start = Date.now();
    }
    console.log(require('util').inspect(req.files, { depth: null }));

    // IMPORTANT INFO
    // Using express-fileupload, req.files.<FORM NAME>.data is the buffer
    // For us, that means req.files.image.data is the image data

    // console.log(require('util').inspect(req, { depth: null }));

      // Validate the form input
    var tags   = xValidate.tags(req.body);
    var uid    = xValidate.uid(req.body);
    var augNum = xValidate.augNum(req.body);

    if (tags == -1 || uid == -1 || augNum == -1) {
        console.log("Is valid input: false");
        return res.json({
            'comment':'Invalid data submitted',
            'tags':tags,
            'uid':uid,
            'augNum':augNum
        });
    }


    // Need to validate imageObject?
    var imgObj = req.files.image;
    var now    = Date.now();
    var filename = __dirname + `/tmp/${now}-${uid}.jpg`

    if (imgObj.data.length >= 500000) {
        console.log("Image size too large, rejected");
        return res.json({'comment':'Image file MUST be less than 500KB'});
    }

    if (imgObj.mimetype.includes("jpeg") == false && imgObj.mimetype.includes("jpg") == false) {
        console.log("File upload format incorrect, rejected");
        return res.json({'comment':'Image file MUST be a JPEG less than 500KB'});
    }

    var imgObjPromise = util.promisify(imgObj.mv);

    imgObjPromise(filename).then( async function() {
        // Check if UID is unique in DynamoDB
        var uniqueItem = await xDynamo.checkDuplicate(uid);
        console.log(`Is Unique UID: ${uniqueItem}`);
        if (uniqueItem === false)  return res.json({'comment': 'UID was duplicate!'});

        // Check if image bin successfully uploaded to S3
        var originalURL = `https://s3.${AWSREGION}.amazonaws.com/${BUCKETNAME}/${uid}.jpg`;
        var addedItemS3 = await xS3.moveToS3(filename, uid, augNum);
        console.log(`Put image in entry S3: ${addedItemS3}`);
        if (addedItemS3 === false) return res.json({'comment':'Failed to upload to S3 bucket'});

        // Wait here for lambda to do its thing
        // Get URLs of all augmented images

        // Check if meta object successfully added to DynamoDB
        var addedItemDynamo = await xDynamo.addDynamoEntry(uid, tags, originalURL, augNum);
        console.log(`Put entry in Dynamo: ${addedItemDynamo}`);
        if (addedItemDynamo === false)  return res.json({'comment':'Failed to add DynamoDB entry. No duplicate tags.'});

        // Cleanup tmp files
        fs.unlink(filename, (err) => {
            if (err) console.log(`Error deleting file ${filename}, error: ${err}`);
            else     console.log(`Successfully deleted tmp file: ${filename}`);
        });

        if (TIMER) {
            var end = Date.now();
            console.log(`Successful request, time taken: ${end-start}ms`);
        }
        return res.json({
            'success':'true',
            'comment':'File uploaded!',
            'originalURL': originalURL
        });

    }).catch( (err) => {
        if (err) {
            console.log(err);
            return res.status(500).send(err);
        }
    });


});

var port = process.env.PORT || 80;

var server = app.listen(port, function () {
    console.log('Server running at http://127.0.0.1:' + port + '/');
});
