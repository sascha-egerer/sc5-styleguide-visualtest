'use strict';

var through = require('through2');
var fs = require('fs-extra');
var Gemini = require('gemini/api');
var spawn = require('child_process').spawn;
var path = require('path');
var gutil = require('gulp-util');
var _ = require('lodash');

let removeDuplicates = (arr, newArr = []) => {
  arr.forEach(item => newArr.indexOf(item) < 0 && newArr.push(item));
  return newArr;
};

var phantomProcess;
var runPhantom = function() {
    phantomProcess = spawn('phantomjs',  ['--webdriver', '4444', '--disk-cache', 'false', '--ignore-ssl-errors', 'true'],  {setsid:true});
    phantomProcess.stdout.pipe(process.stdout);
};

var getGemini = function(options) {

    var geminiOptions = {
      rootUrl: options.rootUrl,
      system: {
        projectRoot: './'
      },
      gridUrl: 'http://127.0.0.1:4444/wd/hub',
      screenshotsDir: options.gridScreenshotsDir,
      browsers: {
        "chrome-latest": {
          desiredCapabilities: {
            browserName: 'chrome',
            version: '37.0'
          }
        }
      },
      windowSize: '1024x768'
    }
    geminiOptions = _.merge(geminiOptions, options.geminiOptions);

    return new Gemini(geminiOptions);
}

var normalize = function (options) {
  if (options.sections && Object.prototype.toString.call(options.sections) !== '[object Array]') {
    options.sections = [options.sections];
  }
  return options;
}

var getTestPaths  = function (options, allTests) {
  if (!allTests) {
    var allTests = require(path.resolve(process.cwd(), options.configDir, './pages-list.js'));
  }

  if (options.sections) {
    // For the given sections
    var tests = options.sections;
    allTests.forEach((section) => {
      options.sections.forEach((sectionToInclude) => {
        if (section.startsWith(sectionToInclude)) {
          tests.push(section);
        }
      });
      tests.sort();
      tests = removeDuplicates(tests);
    });
  } else {
    // For all the sections
    var tests = allTests;
  }

  var testPaths = tests.map((sec) => {
    return path.resolve(options.configDir, './test_' + sec + '.js');
  });
  return testPaths;
}

module.exports.test = function(options) {

  // Gemini does not configurate report dir
  options.reportDir = 'gemini-report';

  options = normalize(options);

  var test = function(file, enc, callback) {

    var gemini = getGemini(options);

    // Run PhantomJs
    runPhantom();

    // Clean report
    fs.removeSync(options.reportDir + '/*');

    // Run tests and create reports
    var runTests = function() {

      var testPaths = getTestPaths(options);

      var runTestsPromise = gemini.test(testPaths, {
        reporters: ['html', 'flat'],
        tempDir: options.reportDir
      });
      runTestsPromise.done(result => {
        phantomProcess.kill('SIGTERM');
        spawn('open', [`${options.reportDir}/index.html`]).on('error', function() {});
      });
    };
    // TODO: remake with promises
    setTimeout(runTests, 2000);

  }

  return through.obj(test);

}

module.exports.gather = function(options) {

  options = normalize(options);

  var gather = function(file, enc, callback) {

    // Provide configuration
    var getPages = function(path) {
      var styleguideData = JSON.parse(fs.readFileSync(`${path}/styleguide.json`));
      var examples = [];
      if (options.sections !== false) {
        // If section is in parameters, take only it and its children
        var res = [];
        styleguideData.sections.forEach(section => {
          options.sections.forEach(sectionToInclude => {
            if (section.reference.startsWith(sectionToInclude)) {
              res.push(section)
            }
          });
        });
        styleguideData.sections = res;
      }
      styleguideData.sections.forEach(section => {
        if (!section.markup) { // For sections with markup only
          return;
        }
        if (section.modifiers.length === 0) {
          // Only for the pages with markup
          // Exclude pages
          if (options.excludePages.indexOf(section.reference) !== -1) {
            return;
          }
          examples.push(section.reference);
        } else {
          section.modifiers.forEach(function (modifier) {
            var modifierFileIdentifier = section.reference + '-' + modifier.className.replace(' ', '_');

            // Exclude pages
            if (options.excludePages.indexOf(modifierFileIdentifier) !== -1) {
                return;
            }
            examples.push(modifierFileIdentifier);
          });
        }
      });
      return examples;
    };

    var styleguidePath = file.path;

    var pages = getPages(styleguidePath);

    var currentSections = (function(options) {
      var pagesListPath = path.join(process.cwd(), options.configDir, './pages-list.js');
      if (fs.existsSync(pagesListPath)) {
        return require(pagesListPath);
      } else {
        return [];
      }
    })(options);

    // If sections are define, ADD them into existing file
    if (options.sections) {
      pages = currentSections.concat(pages);
      pages = removeDuplicates(pages);
      pages.sort();
    } else {
      // If sections are not defined, rewrite whole file
    }

    var testSource = fs.readFileSync(path.join(__dirname, './_basic-test.js'), "utf8");
    [
      './_core-test.js',
      './_build-page-obj.js'
    ].forEach((fileName) => {
      var source = fs.readFileSync(path.join(__dirname, fileName), "utf8");
      var file = new gutil.File({
        base: path.join(__dirname),
        cwd: __dirname,
        path: path.join(__dirname, fileName),
        contents: new Buffer(source)
      });
      this.push(file);
    });

    var pagesJsonString = JSON.stringify(pages, null, 4);

    // list of pages
    var file = new gutil.File({
      base: path.join(__dirname),
      cwd: __dirname,
      path: path.join(__dirname, './pages-list.js'),
      contents: new Buffer(`module.exports = ${pagesJsonString}`)
    });
    this.push(file);

    pages.forEach((page) => {
        var coreTestPath = options.coreTest || "./_core-test";
        coreTestPath = options.customTests && options.customTests[page] ? options.customTests[page] : coreTestPath;
        var content = testSource.replace('"<% EXAMPLES %>"', `["${page}"]`);
        content = content.replace('<% TEST_PATH %>', coreTestPath);

        var file = new gutil.File({
        base: path.join(__dirname),
        cwd: __dirname,
        path: path.join(__dirname, `./test_${page}.js`),
        contents: new Buffer(content)
        });
        this.push(file);
    });

    var gemini = getGemini(options);

    // Run PhantomJs
    runPhantom();

    // Clean screenshot
    if (!options.sections) { // only for full replacement
      fs.removeSync(options.gridScreenshotsDir);
    }

    var runGather = function() {

      var testPaths = getTestPaths(options, pages);

      gemini.update(testPaths, {
        reporters: ['flat'],
      })
      .done(result => {
        phantomProcess.kill('SIGTERM');
      });
    }
    // TODO: remake with promises
    setTimeout(runGather, 2000);

  };

  return through.obj(gather);

};
